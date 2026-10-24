import { RpcErrorCode, type Thread } from '@boite/contracts';
import { RpcFailure } from '../client';
import { pathKey } from './checks';
import type { FakeContext } from './context';

/** The checkout a bot gives its project worker, keeping the bot itself in its brain folder. */
export function delegationProject(ctx: FakeContext, parent: Thread, wanted?: string): Thread {
  const agentId = ctx.agents.ownerOf(parent.id);
  const agent = agentId ? ctx.agents.profileOf(agentId) : null;
  const entrusted = ctx.projects.filter(project => agent?.projectIds?.includes(project.id) && !project.archived && project.kind !== 'drafts');
  let project = parent.projectId === null && entrusted.length === 1 ? entrusted[0] : undefined;
  if (wanted !== undefined) {
    if (typeof wanted !== 'string' || !wanted.trim()) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'project: expected a project id, name or path' });
    const query = wanted.trim();
    const byId = ctx.projects.find(entry => entry.id === query);
    const byPath = ctx.projects.find(entry => pathKey(entry.path) === pathKey(query));
    const byName = ctx.projects.filter(entry => entry.name.toLowerCase() === query.toLowerCase());
    if (!byId && !byPath && byName.length > 1) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `project: ${byName.length} projects are named ${query}; name one by its id or folder` });
    project = byId ?? byPath ?? byName[0];
    if (!project || project.archived || (agent ? !entrusted.includes(project) : parent.projectId !== project.id)) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'project: expected an entrusted project for a bot, or this conversation\'s own project' });
    }
  }
  return project && parent.projectId === null ? { ...parent, projectId: project.id, cwd: project.path, branch: null } : parent;
}
