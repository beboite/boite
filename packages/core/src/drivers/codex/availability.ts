import type { CodexTurnError } from './protocol.ts';
import type { CodexTurn } from './turn.ts';
import type { TurnRefusal } from '../types.ts';
import { errorCodeOf, httpStatusOf } from '../driver-log.ts';

/*
 * What Codex says about availability: a model at capacity, a spent usage
 * window and when it resets. The core retries or resumes on it
 * (`threads/turn-attempts.ts`, `threads/limit-resume.ts`).
 */

/** An `error` notification: a line in the log and the diagnostics, and the code a failure that follows may lack. */
export function turnError(turn: CodexTurn, params: Record<string, unknown>): void {
  const error = params['error'] as CodexTurnError | undefined;
  const willRetry = params['willRetry'] === true;
  const text = error?.message ?? 'the codex agent reported an error';
  const info = error?.codexErrorInfo;
  const code = errorCodeOf(info);
  const status = httpStatusOf(info);
  turn.ctx.diagnostic?.('warn', `Codex reported ${code ?? 'an error'}${status === null ? '' : ` (HTTP ${status})`}${willRetry ? ', it retries' : ', no retry'}: ${text}`, {
    event: willRetry ? 'driver.api.retry' : 'driver.api.error', data: { code, status, willRetry },
  });
  turn.ctx.log('warn', `codex agent: ${text}${willRetry ? ' (retrying)' : ''}`);
  if (willRetry) turn.ctx.reportProgress?.('retrying', text);
  else if (info !== undefined && info !== null) turn.lastErrorInfo = info;
}

/**
 * What a failed Codex turn says about availability. The code is the source;
 * the sentences are the ones the agent writes for those codes, for a failure
 * that reached the turn without its code.
 */
export function codexRefusal(info: unknown, message: string | undefined, resetsAt: number | null): TurnRefusal | undefined {
  const code = errorCodeOf(info);
  if (code === 'serverOverloaded' || /\bSelected model is at capacity\b/i.test(message ?? '')) return { kind: 'capacity' };
  if (code === 'usageLimitExceeded' || /\bYou['\u2019]ve hit your usage limit\b/i.test(message ?? '')) return { kind: 'usage-limit', resetsAt };
  return undefined;
}

/**
 * The reset of the latest window a rate limit snapshot reports as spent, in
 * milliseconds, or null when no window is at 100 %. Codex sends `resetsAt` in
 * seconds; the later of two spent windows is the one that blocks.
 */
export function spentWindowReset(snapshot: unknown): number | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  let latest: number | null = null;
  for (const key of ['primary', 'secondary']) {
    const window = (snapshot as Record<string, unknown>)[key];
    if (window === null || typeof window !== 'object') continue;
    const { usedPercent, resetsAt } = window as Record<string, unknown>;
    if (typeof usedPercent !== 'number' || usedPercent < 100 || typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) continue;
    const at = resetsAt * (resetsAt < 1e12 ? 1000 : 1);
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/**
 * The account's spent windows across limits, from sparse
 * `account/rateLimits/updated` snapshots: a snapshot names its limit, and one
 * that carries no window changes nothing.
 */
export class SpentWindows {
  private readonly byLimit = new Map<string, number | null>();

  /** True when the snapshot changed what is known. */
  note(snapshot: unknown): boolean {
    if (snapshot === null || typeof snapshot !== 'object') return false;
    const record = snapshot as Record<string, unknown>;
    if (record['primary'] == null && record['secondary'] == null) return false;
    this.byLimit.set(typeof record['limitId'] === 'string' ? record['limitId'] : 'codex', spentWindowReset(snapshot));
    return true;
  }

  /** The latest reset among spent windows: the one that blocks. Null when none is spent. */
  latest(): number | null {
    let latest: number | null = null;
    for (const at of this.byLimit.values()) if (at !== null && (latest === null || at > latest)) latest = at;
    return latest;
  }
}
