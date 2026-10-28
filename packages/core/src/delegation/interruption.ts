import type { BackgroundInterruption, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { taskTurn } from './completion.ts';

/** Why a delegated agent's background work ended without waking it, in the words its parent reads. */
export const INTERRUPTION_TEXT: Record<BackgroundInterruption, string> = {
  'error': 'the task failed',
  'cancelled': 'the task was cancelled',
  'no-longer-reported': 'its agent stopped reporting the task (its process ended)',
  'session-ended': 'its agent process was ended',
  'core-restarted': 'Boite or the PC restarted',
};

/** Whether a child's parent hears of its checkpoint now: a paused or off team hears on its resume. */
export function parentListens(core: Core, thread: ThreadSummary): boolean {
  if (core.delegation.remote.parentOf(thread.id)) return !thread.archived;
  const root = core.journal.getThread(thread.parentThreadId!);
  const config = root ? core.delegation.config(root.id) : null;
  return !!root && !!config?.enabled && !config.paused && !root.archived && !thread.archived;
}

/**
 * The parent learns once per turn that the background work a checkpoint
 * waited on ended, or completed, with no result to follow, and how to continue it.
 */
export function tellInterrupted(core: Core, thread: ThreadSummary, tasks: string, how: string, reason: string): void {
  const root = core.journal.getThread(thread.parentThreadId!);
  const link = core.delegation.remote.parentOf(thread.id);
  const turn = taskTurn(core, thread.id);
  if ((!root && !link) || !turn || !parentListens(core, thread)) return;
  const parentId = root?.id ?? link!.parentId;
  const requestId = `result:interrupted:${turn.id}`;
  if (core.journal.db.query('SELECT 1 FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(thread.id, requestId)) return;
  core.logs.warn(`Subagent ${thread.id} of ${parentId} was waiting on ${tasks}; it ${how}`, {
    source: 'delegation', event: 'delegation.interrupted', threadId: thread.id, turnId: turn.id, data: { parent: parentId, reason },
  });
  const resume = link ? '' : `boite delegate resume ${thread.id} continues it; `;
  const text = `${thread.title}: interrupted\nIt was waiting on its background work (${tasks}), which ${how}. Its last message was a checkpoint, not its final result. ${resume}boite delegate send ${thread.id} "<instruction>" steers it.`.slice(0, 4000);
  try {
    if (link) core.delegation.remote.letter(thread.id, { origin: 'result', requestId, text });
    else core.delegation.send({ threadId: thread.id, toThreadId: parentId, requestId, text }, 'result');
  } catch (error) { core.log('warn', `delegation interruption ${thread.id}: ${messageOf(error)}`); }
}
