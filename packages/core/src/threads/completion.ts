import type { ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';

/**
 * Who asks for the family to be put away. The user marking one conversation
 * done is `explicit`: unsent input does not block the user's action.
 * Automatic passes (retention) respect reported input and clients that could
 * not say which threads hold input, since nobody is watching the removal.
 */
export type CompletionRequest = 'explicit' | 'automatic';

/** What still holds a member of the family, in words a refusal can show. */
function pending(core: Core, id: ThreadId, scheduled: Set<ThreadId>, request: CompletionRequest): string | null {
  const threads = core.threads;
  if (threads.isBusy(id) || scheduled.has(id) || threads.runner.steering.has(id)) return 'a turn is still running';
  if (threads.agentState.background.get(id)?.length) return 'background work is still running';
  if (threads.moves.pendingOf(id)) return 'a move is still in progress';
  if (threads.deferred.deferredAnswers.get(id)?.length || threads.deferred.pendingWakes.has(id)) return 'a message is still waiting to be delivered';
  // Done stops a paused run, as archiving does; only an automatic pass keeps it for its resume.
  if (request === 'explicit' ? core.workflows.atWork(id) : core.workflows.active(id)) return 'a workflow is still running';
  if (request === 'automatic' && threads.focus.hasProtectedInput(id)) return 'unsent input is still open on a device';
  if (threads.sideQuestions.active(id)) return 'a side question is still open';
  if (threads.cards.listPermissions(id).length
    || [...threads.cards.questions.values()].some(card => card.request.threadId === id)
    || [...threads.cards.asyncCards.values()].some(card => card.threadId === id)) return 'a permission or question is still waiting for an answer';
  return null;
}

/** The final, synchronous guard for Done; another client may have started work since the row was drawn. */
export function assertIdleFamily(core: Core, threadId: ThreadId, request: CompletionRequest = 'automatic'): void {
  const family = core.journal.db.query('WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT child.id FROM threads child JOIN family ON child.parent_thread_id = family.id) SELECT id FROM family').all(threadId) as { id: ThreadId }[];
  const scheduler = core.scheduler.state();
  const scheduled = new Set([...scheduler.running, ...scheduler.queued].map(turn => turn.threadId));
  for (const { id } of family) {
    const thread = core.journal.getThread(id);
    if (!thread) continue;
    const reason = pending(core, id, scheduled, request);
    if (reason === null) continue;
    const where = id === threadId ? '' : ` in "${thread.title}"`;
    throw refused(`threadId: ${reason}${where}; expected an idle conversation family`, {
      threadId, field: 'threadId', expected: 'an idle conversation family without pending input', activeThreadId: id, reason,
    });
  }
}
