/**
 * `agents.create`: a thread the user asked for a bot makes it, as the Bots
 * page does, without a card. Its route resolves as `boite delegate` reads a
 * model, from the calling thread: its own route when none is named. The
 * shared checks live in contracts/agent-create.ts, where the in-memory client
 * reads them.
 */
import { checkAgentCreate, type AgentCreateParams, type AgentCreateResult, type DelegationConfig } from '@boite/contracts';
import type { Core } from '../core.ts';
import { resolveRoute } from '../delegation/routes.ts';
import { refused, RpcFailure } from '../errors.ts';
import { checkModel } from '../threads/selection.ts';
import type { AgentStore } from './store.ts';

/** Any installed model, as a subagent with no limits would read it: a bot's own policy comes later, from the owner. */
const CREATE_ROUTES: DelegationConfig = { enabled: true, paused: false, profiles: [], anyModel: true };

export function createAgent(core: Core, store: AgentStore, params: AgentCreateParams): AgentCreateResult {
  const thread = core.threads.require(params.threadId);
  if (thread.archived) throw refused('an archived thread cannot create a bot', { threadId: thread.id });
  const checked = checkAgentCreate(params, {
    bots: store.records.list('profile').filter(agent => agent.status !== 'archived'),
    projects: core.projects.list().filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name })),
    route: (model, effort) => {
      try {
        const route = resolveRoute(core, thread, CREATE_ROUTES, { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });
        const provider = core.providers.require(route.providerId);
        // As `agents.profile.save` fills a route on the provider's default model.
        const chosen = checkModel(provider, route.accountId, route.model ?? provider.models.find(m => m.default)?.id ?? provider.models[0]?.id ?? null);
        if (chosen === null) return { ok: false, message: 'model: this thread runs on its provider\'s default model; name one with --model' };
        // Full access, as a bot made on the Bots page.
        return { ok: true, value: { providerId: route.providerId, accountId: route.accountId, model: chosen, effort: effort === undefined ? null : route.effort, permissionMode: 'bypassPermissions' } };
      } catch (error) {
        if (error instanceof RpcFailure) return { ok: false, message: error.message };
        throw error;
      }
    },
  });
  if (!checked.ok) throw refused(checked.message, checked.data);
  const { name, domain, instructions, projectIds, selection } = checked.value;
  const agent = store.saveProfile({ value: { name, domain, instructions, avatar: '', status: 'active', projectIds, selection } });
  return { agent, threadId: store.sessionOf(agent.id)?.threadId ?? null };
}
