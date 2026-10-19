import type { ProviderId, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';

/**
 * How long an automatic update waits for the work agents of its provider run
 * in the background. A background task lives two hours at most, so the work
 * that ran when the update was asked has ended by then; only work started
 * since is cut, and its agents are resumed after the update.
 */
export const BACKGROUND_LIMIT_MS = 2 * 60 * 60 * 1000;

/**
 * The threads of this provider whose turn ended while work their agent
 * started in the background still runs (a CI loop, a dev server, a monitor),
 * with that work named. Releasing the agent would end it, so an update holds
 * for them as for a running turn. A thread with a turn under way counts as
 * that turn.
 */
export function backgroundHolders(core: Core, providerId: ProviderId): Map<ThreadId, string> {
  const holders = new Map<ThreadId, string>();
  for (const [threadId, tasks] of core.threads.agentState.background) {
    if (tasks.length === 0 || core.journal.runningTurn(threadId) !== null) continue;
    if (core.journal.getThread(threadId)?.providerId !== providerId) continue;
    holders.set(threadId, [...new Set(tasks.map(task => task.description.trim() || task.kind))].join(', '));
  }
  return holders;
}

/**
 * Picks the agents back up whose background work an update ended: a
 * delegated agent gets the continuation `boite delegate resume` sends, a
 * conversation of its own resumes like background work that ended without
 * waking it. Each thread says why, so nobody has to notice the cut.
 */
export function resumeCut(core: Core, cut: ReadonlyMap<ThreadId, string>, name: string): void {
  for (const [threadId, work] of cut) {
    const thread = core.journal.getThread(threadId);
    if (thread === null || thread.archived) continue;
    const row = core.journal.db.query('SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1').get(threadId) as { id: string } | null;
    const told = `Boite updated ${name}, which ended your background work (${work}). Check its result and start again what did not finish, then go on with your task.`;
    try {
      if (row !== null) core.threads.noteSystem(threadId, row.id, told, `Background work ended by the ${name} update`, 'turn.cutByUpdate');
      if (thread.parentThreadId) {
        // A team its owner paused stays paused: the parent's notice says how to go on.
        if (!core.delegation.config(thread.parentThreadId).paused) core.delegation.resume(thread.parentThreadId, threadId, 'agent');
      } else core.threads.autoContinue.resumeCut(threadId, told);
    } catch (error) {
      core.log('warn', `resuming ${threadId} after the ${name} update: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
