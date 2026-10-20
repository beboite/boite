import { messageOf } from '../../errors.ts';
import { codexQuotaDetails, codexQuotaWindows } from '../../quota-details.ts';
import type { SessionContext } from '../types.ts';
import type { CodexRpc } from './rpc.ts';

/** How long a full `account/rateLimits/read` stays the base that rolling updates merge into. */
const BASE_MS = 60_000;

type Snapshot = Record<string, unknown>;
const isObject = (value: unknown): value is Snapshot => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `update`'s fields over `target`'s; a null field is "not in this update".
 * `under` keeps the fields `target` already carries.
 */
function merged(target: Snapshot, update: Snapshot, under = false): Snapshot {
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === undefined || (under && target[key] !== null && target[key] !== undefined)) continue;
    target[key] = value;
  }
  return target;
}

/**
 * `account/rateLimits/updated` from a live app-server, turned into the reading
 * a quota read would give, so the Limits views need no probe process while a
 * Codex session runs. The update is sparse: a null field means "not in this
 * update", and it carries no reset credits. So it is merged into the latest
 * full read of this same process, which is fetched again once it is older
 * than a minute. The updates around that read wait for its answer, each kind
 * folded into one set of fields. Those the app-server sent before the answer
 * are older than the read: they fill only the fields it does not carry. Those
 * sent after it can share the answer's chunk of stdout and be handled before
 * the awaited answer lands: they go over it. A read that fails stops the
 * forwarding for this process, and the quota probe answers as before.
 */
export class CodexRateLimits {
  private base: Snapshot | null = null;
  private readAt = 0;
  private reading: Promise<void> | null = null;
  /** Whether the app-server answered the read: the updates after it are newer. */
  private answered = false;
  /** The latest field of each update before the answer, and after it. */
  private before: Snapshot | null = null;
  private after: Snapshot | null = null;
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
    if (this.refused || this.sink() === undefined) return;
    const update = params['rateLimits'];
    if (!isObject(update) || (update['limitId'] != null && update['limitId'] !== 'codex')) return;
    if (this.reading !== null) {
      if (this.answered) this.after = merged(this.after ?? {}, update);
      else this.before = merged(this.before ?? {}, update);
      return;
    }
    if (this.base === null || Date.now() - this.readAt > BASE_MS) {
      this.before = merged({}, update);
      this.reading = this.read().finally(() => { this.reading = null; });
      return;
    }
    this.merge(update);
  }

  private merge(update: Snapshot): void {
    const target = this.base === null ? null : this.target(this.base);
    if (target === null) return;
    merged(target, update);
    this.forward();
  }

  private async read(): Promise<void> {
    const rpc = this.rpc();
    if (rpc === null) return;
    this.answered = false;
    try {
      const raw = await rpc.request<unknown>('account/rateLimits/read', {}, { onAccepted: () => { this.answered = true; } });
      if (!isObject(raw)) throw new Error('the answer is not an object');
      this.base = raw;
      this.readAt = Date.now();
      const { before, after } = this;
      this.before = this.after = null;
      const target = this.target(raw);
      if (target !== null) {
        if (before !== null) merged(target, before, true);
        if (after !== null) merged(target, after);
      }
      this.forward();
    } catch (error) {
      this.before = this.after = null;
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
