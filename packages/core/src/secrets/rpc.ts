/**
 * The `secrets.*` methods. Agents ask, use and list for their own thread
 * (`AGENT_METHODS`); answering with a value and deleting a key from a paired
 * device need a link nobody reads on the way (`Connection.encrypted`).
 */
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';

export function registerSecretMethods(core: Core): void {
  core.router.register('secrets.pending', (params) => {
    if ('threadId' in params) {
      if (typeof params.threadId !== 'string') throw refused('secrets.pending: threadId must be a string', { field: 'threadId', expected: 'a thread id' });
      core.threads.require(params.threadId);
    }
    return core.secrets.pending(params.threadId);
  });
  core.router.register('secrets.ask', (params, ctx) => core.secrets.ask(params, ctx.connection));
  core.router.register('secrets.answer', (params, ctx) => core.secrets.answer(params, ctx.connection.encrypted === true));
  core.router.register('secrets.use', (params, ctx) => core.secrets.use(params, ctx.connection));
  core.router.register('secrets.list', async (params, ctx) => {
    for (const field of ['threadId', 'projectId'] as const) {
      if (field in params && typeof (params as Record<string, unknown>)[field] !== 'string') throw refused(`secrets.list: ${field} must be a string`, { field, expected: field === 'threadId' ? 'a thread id' : 'a project id' });
    }
    const projectId = 'threadId' in params && typeof params.threadId === 'string'
      ? core.threads.require(params.threadId).projectId
      : 'projectId' in params && typeof params.projectId === 'string' ? core.projects.require(params.projectId).id : null;
    if (projectId === null && !('threadId' in params)) throw refused('secrets.list: expected threadId or projectId', { field: 'projectId', expected: 'a project id' });
    return { ...(await core.secrets.list(projectId)), encrypted: ctx.connection.encrypted === true };
  });
  core.router.register('secrets.delete', async (params, ctx) => {
    if (ctx.connection.identity.principal !== 'owner' && ctx.connection.encrypted !== true) {
      throw refused('secrets.delete: a paired device deletes a key only over an encrypted link; use the PC or HTTPS', { field: 'connection', expected: 'loopback, Tailscale or HTTPS' });
    }
    core.projects.require(params.projectId);
    await core.secrets.delete(params.projectId, params.name);
    return { ok: true as const };
  });
}
