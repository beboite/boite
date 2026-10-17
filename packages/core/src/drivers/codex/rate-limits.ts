import { messageOf } from '../../errors.ts';
import { codexQuotaDetails, codexQuotaWindows } from '../../quota-details.ts';
import type { SessionContext } from '../types.ts';
import type { CodexRpc } from './rpc.ts';

/** How long a full `account/rateLimits/read` stays the base that rolling updates merge into. */
const BASE_MS = 60_000;

type Snapshot = Record<string, unknown>;
const isObject = (value: unknown): value is Snapshot => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `account/rateLimits/updated` from a live app-server, turned into the reading
 * a quota read would give, so the Limits views need no probe process while a
 * Codex session runs. The update is sparse: a null field means "not in this
 * update", and it carries no reset credits. So it is merged into the latest
 * full read of this same process, which is fetched again once it is older
 * than a minute. A read that fails stops the forwarding for this process, and
 * the quota probe answers as before.
 */
export class CodexRateLimits {
  private base: Snapshot | null = null;
  private readAt = 0;
  private reading: Promise<void> | null = null;
  private refused = false;

  constructor(
    private readonly rpc: () => CodexRpc | null,
    /** The running turn's context, else the one the process was opened with. */
    private readonly host: () => Pick<SessionContext, 'quota' | 'log'> | null,
  ) {}

  private sink(): SessionContext['quota'] {
    return this.host()?.quota;
  }

  updated(params: Snapshot): void {
    if (this.refused || this.reading !== null || this.sink() === undefined) return;
    const update = params['rateLimits'];
    if (!isObject(update) || (update['limitId'] != null && update['limitId'] !== 'codex')) return;
    if (this.base === null || Date.now() - this.readAt > BASE_MS) {
      // The fresh read already holds this update.
      this.reading = this.read().finally(() => { this.reading = null; });
      return;
    }
    const target = this.target(this.base);
    if (target === null) return;
    for (const [key, value] of Object.entries(update)) if (value !== null && value !== undefined) target[key] = value;
    this.forward();
  }

  private async read(): Promise<void> {
    const rpc = this.rpc();
    if (rpc === null) return;
    try {
      const raw = await rpc.request<unknown>('account/rateLimits/read', {});
      if (!isObject(raw)) throw new Error('the answer is not an object');
      this.base = raw;
      this.readAt = Date.now();
      this.forward();
    } catch (error) {
      this.refused = true;
      this.host()?.log('info', `codex: account/rateLimits/read failed in a live session, limits are probed instead: ${messageOf(error)}`);
    }
  }

  /** The Codex bucket of a full read, the one `codexQuotaWindows` reads. */
  private target(raw: Snapshot): Snapshot | null {
    const byId = raw['rateLimitsByLimitId'];
    if (isObject(byId) && isObject(byId['codex'])) return byId['codex'];
    return isObject(raw['rateLimits']) ? raw['rateLimits'] : null;
  }

  private forward(): void {
    if (this.base === null) return;
    const windows = codexQuotaWindows(this.base);
    if (windows.length === 0) return;
    this.sink()?.({ windows, ...codexQuotaDetails(this.base) }, Date.now());
  }
}
