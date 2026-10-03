import type { ThreadId } from '@boite/contracts';
import type { FakeContext } from './context';
import { refusal } from './shared';
import { hasActiveSideQuestion, retainedFamilyIds } from './side-questions';

/** Same final Done guard as the core, before archive changes or cancellation. */
export function assertIdleFamily(ctx: FakeContext, threadId: ThreadId): void {
  const scheduled = new Set([...ctx.scheduler.running, ...ctx.scheduler.queued].map(turn => turn.threadId));
  for (const id of retainedFamilyIds(ctx, threadId)) {
    const thread = ctx.threads.get(id);
    if (!thread) continue;
    if (['running', 'waiting', 'queued'].includes(thread.status) || scheduled.has(id) || ctx.inFlight.has(id)
      || thread.background?.length || thread.pendingMove || ctx.hasProtectedInput(id) || hasActiveSideQuestion(ctx, id)
      || ctx.heldAnswers.get(id)?.length || ctx.workflows.active(id)
      || [...ctx.pendingPermissions.values(), ...ctx.pendingQuestions.values()].some(card => card.request.threadId === id)) {
      throw refusal('threadId: work or input is still pending; expected an idle conversation family', {
        threadId, field: 'threadId', expected: 'an idle conversation family without pending input', activeThreadId: id,
      });
    }
  }
}
