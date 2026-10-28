import type { ThreadId, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { TurnResult } from '../drivers/types.ts';
import { logMessageOf } from '../log-errors.ts';
import { promptCacheOf } from '../prompt-cache.ts';
import { setThreadStatus } from './records.ts';
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

/** Finish an admitted turn before provider execution, including a held prompt. */
export function markQueuedStopped(core: Core, turnId: TurnId): void {
  const turn = core.journal.getTurn(turnId);
  if (turn === null) return;
  const next: Turn = { ...turn, status: 'stopped', queueHold: null, finishedAt: Date.now() };
  core.bus.afterCommit(() => core.journal.db.transaction(() => {
    core.journal.append({ type: 'turn.stopped', threadId: turn.threadId, version: 1, payload: next }, () => {
      core.journal.putTurn(next);
    });
    if (turn.execution?.operation === 'coordination') core.coordination.queuedCancelled(turn.threadId, turn.id);
    core.bus.emit('turn.finished', next);
    setThreadStatus(core, turn.threadId, 'idle');
  })());
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

/** Called inside the terminal transaction; a newer turn keeps ownership of the thread. */
function finishThread(core: Core, { thread, finished, result }: Settlement): Completion {
  const current = core.journal.getThread(thread.id);
  if (current === null) return { next: null, sameSession: false, threadOwned: false };
  const newer = core.journal.db.query("SELECT id FROM turns WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1").get(thread.id);
  if (newer) return { next: current, sameSession: false, threadOwned: false };
  // Changing the next picker does not grant this result access to the new session.
  const sameSession = (current.sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0)
    && current.sessionId === thread.sessionId && current.providerId === thread.providerId && current.accountId === thread.accountId;
  const sessionId = sameSession ? result.sessionId ?? current.sessionId : current.sessionId;
  // A keepalive is the core's housekeeping: it says nothing new, so it leaves the thread as read as it was,
  // and a failed one leaves it idle, where the result it waits for can still come in (`threads/cache-keepalive.ts`).
  // A quiet wake of a persistent agent had nothing to say either.
  const keepalive = finished.execution?.operation === 'keepalive';
  const quiet = finished.quiet === true;
  const next: ThreadSummary = {
    ...current, sessionId,
    sessionResumeAt: !sameSession ? current.sessionResumeAt : current.sessionResumeAt && sessionId === current.sessionId && sessionId === thread.sessionId ? current.sessionResumeAt : null,
    status: result.status === 'error' && !keepalive ? 'error' : 'idle',
    unread: keepalive || quiet ? current.unread : current.unread || !core.subscribers.hasSubscribers(thread.id),
    promptCache: sameSession ? promptCacheOf(result, thread, finished.finishedAt ?? Date.now(), current.promptCache ?? null) ?? current.promptCache ?? null : current.promptCache ?? null,
    updatedAt: Date.now(),
  };
  core.journal.append({ type: 'thread.finished', threadId: thread.id, version: 1, payload: next }, () => core.journal.putThread(next));
  return { next, sameSession, threadOwned: true };
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
        const toolsClosed = state.result.status !== 'done' ? closeTools(core, running.threadId, running.id) : 0;
        // Read once the answer is written: the flag rides on the turn every listener of `turn.finished` gets.
        if (quietTurn(core, finished)) finished.quiet = true;
        if (toolsClosed > 0) notes.push(() => core.logs.info(`${toolsClosed} tool calls still running were marked failed because the turn ended ${state.result.status}`, { source: 'turns', event: 'turn.tools-closed', threadId: running.threadId, turnId: running.id, data: { tools: toolsClosed, status: state.result.status } }));
        core.journal.append({ type: 'turn.finished', threadId: running.threadId, version: 1, payload: finished }, () => core.journal.putTurn(finished));
        const completion = finishThread(core, state);
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
