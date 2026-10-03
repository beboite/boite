import type { ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';

/** The final, synchronous guard for Done; another client may have started work since the row was drawn. */
export function assertIdleFamily(core: Core, threadId: ThreadId): void {
  const family = core.journal.db.query('WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT child.id FROM threads child JOIN family ON child.parent_thread_id = family.id) SELECT id FROM family').all(threadId) as { id: ThreadId }[];
  const scheduler = core.scheduler.state();
  const scheduled = new Set([...scheduler.running, ...scheduler.queued].map(turn => turn.threadId));
  for (const { id } of family) {
    const thread = core.journal.getThread(id);
    if (!thread) continue;
    if (['running', 'waiting', 'queued'].includes(thread.status) || scheduled.has(id)
      || core.threads.runner.handles.has(id) || core.threads.runner.steering.has(id)
      || core.threads.agentState.background.get(id)?.length || core.threads.moves.pendingOf(id)
      || core.threads.deferred.deferredAnswers.get(id)?.length || core.threads.deferred.pendingWakes.has(id)
      || core.workflows.active(id)
      || core.threads.focus.hasProtectedInput(id) || core.threads.sideQuestions.active(id)
      || core.threads.cards.listPermissions(id).length
      || [...core.threads.cards.questions.values()].some(card => card.request.threadId === id)
      || [...core.threads.cards.asyncCards.values()].some(card => card.threadId === id)) {
      throw refused('threadId: work or input is still pending; expected an idle conversation family', {
        threadId, field: 'threadId', expected: 'an idle conversation family without pending input', activeThreadId: id,
      });
    }
  }
}
