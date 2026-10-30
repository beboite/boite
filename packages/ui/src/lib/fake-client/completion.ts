import { threadActive, type ThreadId } from '@boite/contracts';
import type { FakeContext } from './context';
import { refusal } from './shared';
import { hasActiveSideQuestion, retainedFamilyIds } from './side-questions';

/** What still holds a member of the family, in the core's words. */
function pending(ctx: FakeContext, id: ThreadId, scheduled: Set<ThreadId>, explicit: boolean): string | null {
  const thread = ctx.threads.get(id)!;
  if (threadActive(thread.status) || scheduled.has(id) || ctx.inFlight.has(id)) return 'a turn is still running';
  if (thread.background?.length) return 'background work is still running';
  if (thread.pendingMove) return 'a move is still in progress';
  if (ctx.heldAnswers.get(id)?.length) return 'a message is still waiting to be delivered';
  // Done stops a paused run, as archiving does; only the expiry pass keeps it for its resume.
  if (explicit ? ctx.workflows.atWork(id) : ctx.workflows.active(id)) return 'a workflow is still running';
  // Unsent input protects automatic expiry, never the user's own Done action.
  if (!explicit && ctx.bus.protectedThreadIds.has(id)) return 'unsent input is still open on a device';
  if (hasActiveSideQuestion(ctx, id)) return 'a side question is still open';
  if ([...ctx.pendingPermissions.values(), ...ctx.pendingQuestions.values()].some(card => card.request.threadId === id)) return 'a permission or question is still waiting for an answer';
  return null;
}

/** Same final Done guard as the core, before archive changes or cancellation. */
export function assertIdleFamily(ctx: FakeContext, threadId: ThreadId, explicit = false): void {
  const scheduled = new Set([...ctx.scheduler.running, ...ctx.scheduler.queued].map(turn => turn.threadId));
  for (const id of retainedFamilyIds(ctx, threadId)) {
    const thread = ctx.threads.get(id);
    if (!thread) continue;
    const reason = pending(ctx, id, scheduled, explicit);
    if (reason === null) continue;
    const where = id === threadId ? '' : ` in "${thread.title}"`;
    throw refusal(`threadId: ${reason}${where}; expected an idle conversation family`, {
      threadId, field: 'threadId', expected: 'an idle conversation family without pending input', activeThreadId: id, reason,
    });
  }
}
