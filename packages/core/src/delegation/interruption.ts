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
  const turn = taskTurn(core, thread.id);
  if (!root || !turn || !parentListens(core, thread)) return;
  const requestId = `result:interrupted:${turn.id}`;
  if (core.journal.db.query('SELECT 1 FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(thread.id, requestId)) return;
  core.logs.warn(`Subagent ${thread.id} of ${root.id} was waiting on ${tasks}; it ${how}`, {
    source: 'delegation', event: 'delegation.interrupted', threadId: thread.id, turnId: turn.id, data: { parent: root.id, reason },
  });
  try {
    core.delegation.send({ threadId: thread.id, toThreadId: root.id, requestId, text: `${thread.title}: interrupted\nIt was waiting on its background work (${tasks}), which ${how}. Its last message was a checkpoint, not its final result. boite delegate resume ${thread.id} continues it; boite delegate send ${thread.id} "<instruction>" steers it.`.slice(0, 4000) }, 'result');
  } catch (error) { core.log('warn', `delegation interruption ${thread.id}: ${messageOf(error)}`); }
}
