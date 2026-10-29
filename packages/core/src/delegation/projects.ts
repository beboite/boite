import type { ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';

/** The workspace of a child; the original parent still owns its route and delivery. */
export function childProject(core: Core, parent: ThreadSummary, explicit?: string): Pick<ThreadSummary, 'projectId' | 'cwd' | 'branch'> {
  const bot = core.workforce.projects.botOf(parent.id);
  const entrusted = bot ? core.workforce.projects.projectsOf(bot) : [];
  const project = explicit === undefined
    ? entrusted.length === 1 ? core.projects.require(entrusted[0]!) : null
    : core.projects.find(explicit, 'delegation.spawn', 'project', { threadId: parent.id });
  if (project === null) return parent;
  if (!bot) {
    if (project.id !== parent.projectId) throw refused('delegation.spawn.project: ordinary conversations delegate only in their own project', { field: 'project', expected: 'the parent conversation project' });
    return parent;
  }
  if (!entrusted.includes(project.id)) throw refused(`delegation.spawn.project: ${explicit} is not entrusted to this bot`, { field: 'project', expected: 'a live project entrusted to this bot' });
  return { projectId: project.id, cwd: project.path, branch: null };
}
