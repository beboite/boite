import { threadActive } from '@boite/contracts';
import type { ThreadId, ThreadStatus, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { saveThread } from './records.ts';

/**
 * The only writer of a thread's stored status. Every status follows from the
 * thread's turns and cards:
 *
 * - `queued` while a turn waits in the scheduler,
 * - `running` while a turn runs, `waiting` while that turn waits on a card,
 * - once the last turn closed, `error` when it failed and `idle` otherwise.
 *   A failed keepalive only waited, so it leaves the thread `idle`
 *   (`threads/cache-keepalive.ts`).
 *
 * A turn closed live and one a restarted core closes rest in the same status
 * (`finishTurn` in `threads/turn-settlement.ts`), so delegation, bots and the
 * client read one meaning of `error`.
 */

/** True while a turn of the thread is queued, running or waiting, or the runner still holds its agent. */
export function isBusy(core: Core, threadId: ThreadId): boolean {
  const thread = core.journal.getThread(threadId);
  return (thread !== null && threadActive(thread.status)) || core.threads.runner.handles.has(threadId);
}

/** The status a thread rests in once `turn`, its last, closed. */
export function restingStatus(turn: Turn): Extract<ThreadStatus, 'idle' | 'error'> {
  return turn.status === 'error' && turn.execution?.operation !== 'keepalive' ? 'error' : 'idle';
}

/** A turn was admitted: the thread waits for the scheduler. */
export function markQueued(core: Core, threadId: ThreadId): void {
  write(core, threadId, 'queued');
}

/**
 * The thread's turn runs, or a card of it came or went: `waiting` while a
 * blocking card or a secret holds it, `running` otherwise. A card left over
 * by a turn that already closed moves nothing.
 */
export function markRunning(core: Core, threadId: ThreadId): void {
  if (core.journal.runningTurn(threadId) === null) return;
  write(core, threadId, core.threads.cards.waitingOn(threadId) ? 'waiting' : 'running');
}

/** A thread whose first turn could not even be admitted: it fails with no turn to carry the error. */
export function markStartFailed(core: Core, threadId: ThreadId): void {
  write(core, threadId, 'error');
}

/**
 * A thread whose stored status says a turn is under way while none is (a core
 * that died between two writes): it rests where its last turn left it.
 */
export function settleStatus(core: Core, threadId: ThreadId): void {
  if (core.journal.db.query("SELECT 1 FROM turns WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1").get(threadId)) return;
  const last = core.journal.lastTurn(threadId);
  const thread = core.journal.getThread(threadId);
  if (thread === null) return;
  saveThread(core, { ...thread, status: last === null ? 'idle' : restingStatus(last) }, 'thread.finished');
}

function write(core: Core, threadId: ThreadId, status: ThreadStatus): void {
  const thread = core.journal.getThread(threadId);
  if (thread === null || thread.status === status) return;
  saveThread(core, { ...thread, status }, 'thread.status');
}
