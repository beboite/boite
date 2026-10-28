import type { Principal, WorkflowRun } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { pauseHold } from '../delegation/pauses.ts';

/** The run going again, with no pause left on it. */
export function running(run: WorkflowRun): WorkflowRun {
  const { pausedBy: _by, pausedAt: _at, ...rest } = run;
  return { ...rest, status: 'running', error: null };
}

/** The owner resumes any run; a session none; an agent the pauses `pauseHold` lets it lift. */
export function mayResume(core: Core, run: WorkflowRun, principal: Principal): void {
  if (principal === 'owner') return;
  if (principal === 'session') throw refused('resuming a workflow is an owner action');
  const hold = pauseHold(core, run.rootThreadId, { by: run.pausedBy, at: run.pausedAt }, 'run');
  if (hold) throw refused(hold);
}

/** Resuming a run resumes the team its steps run in, when the caller may lift that pause too. */
export function resumeTeam(core: Core, rootId: string, principal: Principal): void {
  const config = core.delegation.config(rootId);
  if (!config.enabled || !config.paused) return;
  core.delegation.unpause(rootId, principal);
}
