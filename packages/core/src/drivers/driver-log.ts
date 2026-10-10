import type { SessionContext } from './types.ts';

type Diagnosable = Pick<SessionContext, 'diagnostic' | 'warmProcessMinutes'>;

/**
 * Whether a turn got the thread's warm agent process or a new one, and why
 * a kept one was not good enough. A setup change is worth `info`; the routine
 * cases (no process kept, warm processes off) are `debug`.
 */
export function noteWarmSession(ctx: Diagnosable, agent: string, choice: { kept: boolean; usable: boolean; sameSetup: boolean; setupChange?: string }): void {
  const note = ctx.diagnostic;
  if (note === undefined || !choice.kept) return;
  if (choice.usable) {
    note('debug', `Warm ${agent} process reused for this turn`, { event: 'driver.session.reused', data: { warmMinutes: ctx.warmProcessMinutes } });
    return;
  }
  const why = !choice.sameSetup ? (choice.setupChange ?? 'its setup changed') : ctx.warmProcessMinutes <= 0 ? 'warm processes are off' : 'the warm process ended or is closing';
  note(choice.sameSetup ? 'debug' : 'info', `Warm ${agent} process replaced: ${why}`, { event: 'driver.session.replaced', data: { reason: why, warmMinutes: ctx.warmProcessMinutes } });
}

/** A protocol error's code, from the shapes agents use: a string, a number or a one-key object. */
export function errorCodeOf(info: unknown): string | null {
  if (typeof info === 'string') return info.slice(0, 80);
  if (typeof info === 'number' && Number.isFinite(info)) return String(info);
  if (info !== null && typeof info === 'object' && !Array.isArray(info)) {
    const [key] = Object.keys(info);
    return key === undefined ? null : key.slice(0, 80);
  }
  return null;
}

/** An HTTP status anywhere one level down in a protocol error's details. */
export function httpStatusOf(info: unknown): number | null {
  if (info === null || typeof info !== 'object') return null;
  for (const value of [info, ...Object.values(info as Record<string, unknown>)]) {
    if (value === null || typeof value !== 'object') continue;
    const status = (value as Record<string, unknown>).httpStatusCode ?? (value as Record<string, unknown>).status;
    if (typeof status === 'number' && status >= 100 && status < 600) return status;
  }
  return null;
}

/**
 * How long an agent process took to open its session, or why it could not.
 * `opening` runs here, after the clock starts, so synchronous setup counts and
 * a synchronous throw is logged like a rejection. `details` adds what only
 * the session knows once open, such as the model it was served.
 */
export function noteReady<T>(
  ctx: Pick<SessionContext, 'diagnostic' | 'sessionId'>,
  agent: string,
  opening: () => Promise<T>,
  details: () => { text?: string; data?: Record<string, string | number | boolean | null>; resumed?: boolean; abandoned?: boolean } = () => ({}),
): Promise<T> {
  const at = Date.now();
  const resume = ctx.sessionId !== null;
  const failed = (error: unknown): never => {
    ctx.diagnostic?.('warn', `${agent} session failed to open after ${Date.now() - at} ms: ${error instanceof Error ? error.message : String(error)}`, { event: 'driver.session.open-failed', durationMs: Date.now() - at, data: { resume, code: errorCodeOf((error as { code?: unknown } | null)?.code) } });
    throw error;
  };
  let started: Promise<T>;
  try { started = opening(); } catch (error) { return Promise.reject(error).catch(failed); }
  return started.then((value) => {
    const extra = details();
    // Stopped before a process ever started: nothing became ready.
    if (extra.abandoned) {
      ctx.diagnostic?.('debug', `${agent} session open was abandoned after ${Date.now() - at} ms: the thread stopped before a process started`, { event: 'driver.session.open-abandoned', durationMs: Date.now() - at, data: { resume } });
      return value;
    }
    // A session asked to resume can still come back new, when the agent could not load it.
    const resumed = extra.resumed ?? resume;
    ctx.diagnostic?.('info', `${agent} session ready in ${Date.now() - at} ms, ${resumed ? 'resumed' : 'new'}${extra.text ?? ''}`, { event: 'driver.session.ready', durationMs: Date.now() - at, data: { ...extra.data, resume: resumed } });
    return value;
  }, failed);
}
