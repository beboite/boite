import type { ProviderId, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Resume } from './update-resume.ts';

/**
 * How long an automatic update waits for the work agents of its provider run
 * in the background. A background task lives two hours at most, so the work
 * that ran when the update was asked has ended by then; only work started
 * since is cut, and its agents are resumed after the update.
 */
export const BACKGROUND_LIMIT_MS = 2 * 60 * 60 * 1000;

/**
 * The threads of this provider whose agent still runs work it started in the
 * background (a CI loop, a dev server, a monitor), with that work named: a
 * turn that ended on it, or one paused for the update. Releasing the agent
 * would end that work, so an update holds for them as for a running turn. A
 * thread whose turn runs unpaused counts as that turn.
 */
export function backgroundHolders(core: Core, providerId: ProviderId): Map<ThreadId, string> {
  const holders = new Map<ThreadId, string>();
  for (const [threadId, tasks] of core.threads.agentState.background) {
    if (tasks.length === 0 || (core.journal.runningTurn(threadId) !== null && !core.threads.runner.isPaused(threadId))) continue;
    if (core.journal.getThread(threadId)?.providerId !== providerId) continue;
    holders.set(threadId, [...new Set(tasks.map(task => task.description.trim() || task.kind))].join(', '));
  }
  return holders;
}

function told(name: string, work: string): string {
  return `An update of ${name} ended your background work (${work}). Check its result and start again what did not finish, then go on with your task.`;
}

/** What a turn paused for the update is told when the release also ended its background work. */
export function withCut(resume: Resume, name: string, work: string | undefined): Resume {
  return work === undefined ? resume : { ...resume, prompt: `${resume.prompt}\n\n${told(name, work)}` };
}

/**
 * Plans, as the release ends their background work, the resume of the agents
 * whose turn had ended: a delegated agent gets the continuation `boite
 * delegate resume` sends, a conversation of its own resumes like background
 * work that ended without waking it. Both are journalled now, so a Stop
 * during the update cancels them the usual way and a crash keeps them; the
 * scheduler holds their turn until the updater is done. A paused turn is told
 * when it goes on (`withCut`). Each thread says why.
 */
export function resumeCut(core: Core, cut: ReadonlyMap<ThreadId, string>, name: string): void {
  for (const [threadId, work] of cut) {
    const thread = core.journal.getThread(threadId);
    if (thread === null || thread.archived || core.journal.runningTurn(threadId) !== null) continue;
    const row = core.journal.db.query('SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1').get(threadId) as { id: string } | null;
    try {
      if (row !== null) core.threads.noteSystem(threadId, row.id, told(name, work), `Background work ended by the ${name} update`, 'turn.cutByUpdate');
      if (thread.parentThreadId) {
        // A team its owner paused stays paused: the parent's notice says how to go on.
        if (!core.delegation.config(thread.parentThreadId).paused) core.delegation.resume(thread.parentThreadId, threadId, 'agent');
      } else core.threads.autoContinue.resumeCut(threadId, told(name, work));
    } catch (error) {
      core.log('warn', `resuming ${threadId} after the ${name} update: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
