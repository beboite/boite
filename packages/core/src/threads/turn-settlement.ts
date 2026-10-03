import type { ThreadId, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { TurnResult } from '../drivers/types.ts';
import { logMessageOf } from '../log-errors.ts';
import { promptCacheOf } from '../prompt-cache.ts';

interface Settlement {
  queued: Turn;
  running: Turn;
  finished: Turn;
  thread: ThreadSummary;
  result: TurnResult;
  started: boolean;
}
interface Completion { next: ThreadSummary | null; sameSession: boolean; threadOwned: boolean }

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
  const next: ThreadSummary = {
    ...current, sessionId,
    sessionResumeAt: !sameSession ? current.sessionResumeAt : current.sessionResumeAt && sessionId === current.sessionId && sessionId === thread.sessionId ? current.sessionResumeAt : null,
    status: result.status === 'error' ? 'error' : 'idle',
    unread: current.unread || !core.subscribers.hasSubscribers(thread.id),
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
  for (;;) {
    if (core.journal.isClosed()) return null;
    try {
      // releaseTurn drops its buffer after writing. Commit it independently so
      // a later terminal rollback cannot lose the streamed answer.
      core.journal.releaseTurn(running.id);
      core.bus.flush();
      return core.journal.db.transaction(() => {
        if (!ownsTurn(core.journal.getTurn(running.id), state)) return null;
        core.journal.append({ type: 'turn.finished', threadId: running.threadId, version: 1, payload: finished }, () => core.journal.putTurn(finished));
        return finishThread(core, state);
      })();
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
