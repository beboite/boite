/**
 * The last lines each thread's agent printed on stderr. Provider output is
 * never persisted as such (`kind: 'provider-output'`), but when an agent
 * process dies or a turn fails those lines are usually the only cause, so one
 * warning carries their tail, redacted by the log store and cut to
 * `STDERR_TAIL_CHARS`.
 */

export const STDERR_TAIL_CHARS = 500;
const LINES_KEPT = 20;
const THREADS_KEPT = 256;
/** Lines older than this belong to an earlier turn and would mislead. */
const TAIL_AGE_MS = 10 * 60_000;

const tails = new Map<string, { at: number; text: string }[]>();

/** Called for every provider-output line a driver reports for a thread. */
export function noteStderr(threadId: string, line: string, at = Date.now()): void {
  const text = line.trim();
  if (text.length === 0) return;
  let lines = tails.get(threadId);
  if (lines === undefined) {
    lines = [];
    tails.set(threadId, lines);
    if (tails.size > THREADS_KEPT) tails.delete(tails.keys().next().value!);
  }
  lines.push({ at, text: text.slice(0, STDERR_TAIL_CHARS) });
  if (lines.length > LINES_KEPT) lines.splice(0, lines.length - LINES_KEPT);
}

/** The newest lines, oldest first, joined by ` | ` and cut to `max` characters from the end; null when there are none. */
export function stderrTail(threadId: string, max = STDERR_TAIL_CHARS, now = Date.now()): string | null {
  const lines = tails.get(threadId)?.filter(line => now - line.at <= TAIL_AGE_MS);
  if (lines === undefined || lines.length === 0) return null;
  const joined = lines.map(line => line.text).join(' | ');
  return joined.length <= max ? joined : `...${joined.slice(joined.length - max + 3)}`;
}

export function forgetStderr(threadId: string): void {
  tails.delete(threadId);
}
