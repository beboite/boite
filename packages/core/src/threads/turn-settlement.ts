import type { ThreadId, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { TurnResult } from '../drivers/types.ts';
import { logMessageOf } from '../log-errors.ts';
import { promptCacheOf } from '../prompt-cache.ts';
import { withLoad } from './records.ts';
import { restingStatus } from './lifecycle.ts';
import { quietTurn } from '../agents/runtime.ts';

interface Settlement {
  queued: Turn;
  running: Turn;
  finished: Turn;
  thread: ThreadSummary;
  result: TurnResult;
  started: boolean;
}
interface Completion { next: ThreadSummary | null; sameSession: boolean; threadOwned: boolean }

/** How a turn came to close: its runner settled it, it never started, or a restarted core closes what the last one left. */
export type TurnClose = 'settled' | 'never-started' | 'crashed' | 'handed-over';

interface Finished { thread: ThreadSummary | null; owned: boolean; toolsClosed: number }

/**
 * The one writer of a closed turn, inside the caller's transaction: tools the
 * turn left running close as failed, the turn row is written, and the thread
 * rests in the status the turn leaves (`restingStatus`). A newer queued or
 * running turn keeps ownership of the thread status. `patch` adds what only
 * the caller knows to the thread row, such as the session a settled turn ended in.
 * Events go out once the caller committed (`announceFinished`).
 */
export function finishTurn(core: Core, finished: Turn, cause: TurnClose, patch?: (current: ThreadSummary) => ThreadSummary): Finished {
  const threadId = finished.threadId;
  const toolsClosed = finished.status !== 'done' ? closeTools(core, threadId, finished.id) : 0;
  const type = cause !== 'settled' && finished.status === 'stopped' ? 'turn.stopped' : 'turn.finished';
  core.journal.append({ type, threadId, version: 1, payload: finished }, () => core.journal.putTurn(finished));
  const current = core.journal.getThread(threadId);
  if (current === null) return { thread: null, owned: false, toolsClosed };
  const newer = core.journal.db.query("SELECT id FROM turns WHERE thread_id = ? AND id != ? AND status IN ('queued', 'running') LIMIT 1").get(threadId, finished.id);
  if (newer) return { thread: current, owned: false, toolsClosed };
  const next: ThreadSummary = { ...(patch ? patch(current) : current), status: restingStatus(finished), updatedAt: Date.now() };
  core.journal.append({ type: 'thread.finished', threadId, version: 1, payload: next }, () => core.journal.putThread(next));
  return { thread: next, owned: true, toolsClosed };
}

/** Tells every client a turn closed outside a runner, once its transaction committed. */
export function announceFinished(core: Core, finished: Turn, { thread, owned }: Finished): void {
  core.bus.emit('turn.finished', finished);
  if (owned && thread) core.bus.emit('thread.updated', withLoad(core, thread));
}

/** Finish an admitted turn before provider execution, including a held prompt. */
export function markQueuedStopped(core: Core, turnId: TurnId): void {
  const turn = core.journal.getTurn(turnId);
  if (turn === null) return;
  const next: Turn = { ...turn, status: 'stopped', queueHold: null, finishedAt: Date.now() };
  core.bus.afterCommit(() => {
    // The stop and the wake's letters going back to the inbox commit together.
    const done = core.journal.db.transaction(() => {
      const finished = finishTurn(core, next, 'never-started');
      if (turn.execution?.operation === 'coordination') core.coordination.queuedCancelled(turn.threadId, turn.id);
      return finished;
    })();
    announceFinished(core, next, done);
  });
}

/**
 * A turn that ended without its tools ending: a stop that cut a call while the
 * agent was still typing or running it, a crashed agent, a core killed
 * mid-call. Nothing will ever answer those calls, so each card still marked
 * running is closed as failed. Left open, it keeps its spinner and its clock
 * ticking on a turn that is over, and reads as an agent still at work.
 */
export function closeTools(core: Core, threadId: ThreadId, turnId: TurnId): number {
  let closed = 0;
  // Read whole first: each close rewrites a row of the table being walked. Large
  // values stay in part_blobs until a running tool is found; only that part reads them back.
  for (const { id: messageId, parts } of [...core.journal.walkTurnMessages(threadId, turnId, { blobs: false })]) {
    parts.forEach((stored, partIndex) => {
      if (stored.type !== 'tool' || stored.status !== 'running') return;
      const part = core.journal.messagePart(messageId, partIndex)?.part;
      if (part?.type !== 'tool') return;
      closed += 1;
      const payload = { messageId, partIndex, part: { ...part, status: 'error' as const } };
      core.journal.append({ type: 'message.part', threadId, version: 1, payload }, () => core.journal.setMessagePart(messageId, partIndex, payload.part));
      core.bus.emit('message.part', { threadId, ...payload });
    });
  }
  return closed;
}

/** Compare the durable execution identity before writing a late provider result. */
function ownsTurn(owned: Turn | null, { queued, running, started }: Settlement): boolean {
  if (!owned || owned.threadId !== running.threadId || owned.status !== (started ? 'running' : 'queued')
    || owned.startedAt !== (started ? running.startedAt : queued.startedAt) || owned.queuedAt !== running.queuedAt) return false;
  return (['selectionVersion', 'providerId', 'accountId', 'sessionGeneration'] as const)
    .every(field => owned.execution?.[field] === running.execution?.[field]);
}

/** The settled turn's row and its thread's: the session and the prompt cache it ended with. */
function finishThread(core: Core, { thread, finished, result }: Settlement): Completion & { toolsClosed: number } {
  let sameSession = false;
  const done = finishTurn(core, finished, 'settled', current => {
    // Changing the next picker does not grant this result access to the new session.
    sameSession = (current.sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0)
      && current.sessionId === thread.sessionId && current.providerId === thread.providerId && current.accountId === thread.accountId;
    const sessionId = sameSession ? result.sessionId ?? current.sessionId : current.sessionId;
    // A keepalive is the core's housekeeping: it says nothing new, so it leaves the thread as read as it was.
    // A quiet wake of a persistent agent had nothing to say either.
    const silent = finished.execution?.operation === 'keepalive' || finished.quiet === true;
    return {
      ...current, sessionId,
      sessionResumeAt: !sameSession ? current.sessionResumeAt : current.sessionResumeAt && sessionId === current.sessionId && sessionId === thread.sessionId ? current.sessionResumeAt : null,
      unread: silent ? current.unread : current.unread || !core.subscribers.hasSubscribers(thread.id),
      promptCache: sameSession ? promptCacheOf(result, thread, finished.finishedAt ?? Date.now(), current.promptCache ?? null) ?? current.promptCache ?? null : current.promptCache ?? null,
    };
  });
  return { next: done.thread, sameSession: done.owned && sameSession, threadOwned: done.owned, toolsClosed: done.toolsClosed };
}

export function reportSettlementError(core: Core, threadId: ThreadId, turnId: TurnId, phase: string, error: unknown): void {
  try {
    core.log('error', `turn ${turnId} settlement ${phase} failed: ${logMessageOf(error)}`, { source: 'scheduler', event: 'turn.settlement.retry', threadId, turnId });
  } catch { /* A diagnostic storage failure must not break persistence recovery. */ }
}

/** Retry local persistence only, retaining the scheduler slot and the original provider result. */
export async function settleTurn(core: Core, state: Settlement): Promise<Completion | null> {
  const { running, finished } = state;
  let retry = 0;
  const settleAt = performance.now();
  for (;;) {
    if (core.journal.isClosed()) return null;
    try {
      // releaseTurn drops its buffer after writing. Commit it independently so
      // a later terminal rollback cannot lose the streamed answer.
      core.journal.releaseTurn(running.id);
      core.bus.flush();
      // Logged once the transaction commits: a rollback must not leave a record of what did not
      // happen, and a diagnostic storage failure must not abort or retry the settlement.
      const notes: (() => void)[] = [];
      const settled = core.journal.db.transaction(() => {
        const owned = core.journal.getTurn(running.id);
        if (!ownsTurn(owned, state)) {
          notes.push(() => core.logs.warn(`Turn result ${state.result.status} discarded: the journal holds the turn as ${owned?.status ?? 'missing'} with another execution, so a newer run owns it`, {
            source: 'turns', event: 'turn.settlement.abandoned', threadId: running.threadId, turnId: running.id, data: { result: state.result.status, journalStatus: owned?.status ?? null },
          }));
          return null;
        }
        // Read once the answer is written: the flag rides on the turn every listener of `turn.finished` gets.
        if (quietTurn(core, finished)) finished.quiet = true;
        const { toolsClosed, ...completion } = finishThread(core, state);
        if (toolsClosed > 0) notes.push(() => core.logs.info(`${toolsClosed} tool calls still running were marked failed because the turn ended ${state.result.status}`, { source: 'turns', event: 'turn.tools-closed', threadId: running.threadId, turnId: running.id, data: { tools: toolsClosed, status: state.result.status } }));
        const attempts = retry;
        if (attempts > 0) notes.push(() => core.logs.info(`Turn settled after ${attempts} failed persistence attempts`, { source: 'turns', event: 'turn.settlement.recovered', threadId: running.threadId, turnId: running.id, durationMs: performance.now() - settleAt, data: { retries: attempts } }));
        if (!completion.threadOwned) notes.push(() => core.logs.debug('Turn settled, but a newer turn owns the thread status', { source: 'turns', event: 'turn.settlement.not-owner', threadId: running.threadId, turnId: running.id }));
        return completion;
      })();
      for (const note of notes) {
        try { note(); } catch { /* A diagnostic storage failure must not break a committed settlement. */ }
      }
      return settled;
    } catch (error) {
      reportSettlementError(core, running.threadId, running.id, `persistence attempt ${++retry}`, error);
      if (core.stopping || core.journal.isClosed()) return null;
      const delay = Math.min(100 * 2 ** Math.min(retry - 1, 6), 5000);
      const until = Date.now() + delay;
      while (Date.now() < until) {
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, until - Date.now())));
        if (core.stopping || core.journal.isClosed()) return null;
      }
    }
  }
}
