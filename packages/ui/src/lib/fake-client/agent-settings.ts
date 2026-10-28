/**
 * Agent setting cards on the in-memory client, as `packages/core/src/agents/setting-cards.ts`
 * draws them: a thread, or a persistent agent about itself, asks the user to
 * change one of an agent's settings; Apply writes it through the agent's own
 * settings, and any change to the agent settles the cards it answers. A
 * thread creates the bot the user asked for with no card, as the core's
 * `agents/create.ts`.
 */
import {
  AGENT_SETTING_KEYS, AGENT_STATUSES, RpcErrorCode, agentModelRoute, agentSettingProposal, agentSettingValue, providerEnabled, checkAgentCreate, checkAgentSettingRequest, normalizeAgentSetting, settledAgentSetting,
  type AgentCreateContext, type AgentProfile, type AgentSelection, type AgentSettingAsk, type AgentSettingContext, type AgentSettingReading, type AgentSettingRequestParams,
  type DelegationConfig, type RpcParams, type RpcResult, type Thread, type Turn,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import type { AgentSettingMethod } from '../fake-agents';
import type { FakeContext } from './context';
import { pickModel } from './delegation';
import { modelsOf } from './provider-catalog';
import { askAgentSetting } from './requests';

const refused = (message: string, data?: Record<string, unknown>) => new RpcFailure({ code: RpcErrorCode.Refused, message, ...(data ? { data } : {}) });
/** As the core: a new bot may run on any installed model, whatever the thread's subagent settings. */
const CREATE_ROUTES: DelegationConfig = { enabled: true, paused: false, profiles: [], anyModel: true };

/** The agent a call names, by id or name; unnamed, the agent whose session the thread is. */
function agentFor(ctx: FakeContext, threadId: string, name: string | undefined): AgentProfile {
  const live = ctx.agents.liveProfiles();
  if (name === undefined || name.trim() === '') {
    const own = ctx.agents.ownerOf(threadId);
    const profile = own === null ? null : ctx.agents.profileOf(own);
    if (profile) return profile;
    throw refused(`agent: this thread is no agent's conversation; name one: ${live.map(agent => agent.name).join(', ') || 'there are no agents yet'}`, { field: 'agent' });
  }
  const wanted = name.trim();
  const byId = live.find(agent => agent.id === wanted);
  if (byId) return byId;
  const named = live.filter(agent => agent.name.toLowerCase() === wanted.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw refused(`agent: ${named.length} agents are named ${JSON.stringify(wanted)}; name it by id: ${named.map(agent => agent.id).join(', ')}`, { field: 'agent' });
  throw refused(`agent: no agent ${JSON.stringify(wanted)}; the agents are ${live.map(agent => agent.name).join(', ') || 'none yet'}`, { field: 'agent', expected: live.map(agent => agent.name) });
}

/** As the core: the agent's own login on its provider; on another, that provider's first. */
function accountOn(ctx: FakeContext, agent: AgentProfile, providerId: string): string | undefined {
  return providerId === agent.selection.providerId ? agent.selection.accountId : ctx.accounts.find(account => account.providerId === providerId && account.status !== 'unauthenticated')?.id;
}

/** As the core: `<provider>/<model>` of an available provider, or a model id of the agent's own. */
function modelRoute(ctx: FakeContext, agent: AgentProfile, wanted: string): { providerId: string; accountId: string; model: string } | null {
  const slash = wanted.indexOf('/');
  const named = slash > 0 ? ctx.providers.find(provider => provider.id === wanted.slice(0, slash) && (provider.id === agent.selection.providerId || (provider.available && providerEnabled(provider)))) : undefined;
  const accountId = named && accountOn(ctx, agent, named.id);
  if (named && accountId && modelsOf(ctx, named.id, accountId).some(entry => entry.id === wanted.slice(slash + 1))) return { providerId: named.id, accountId, model: wanted.slice(slash + 1) };
  const { providerId, accountId: own } = agent.selection;
  return modelsOf(ctx, providerId, own).some(entry => entry.id === wanted) ? { providerId, accountId: own, model: wanted } : null;
}

function context(ctx: FakeContext, agent: AgentProfile): AgentSettingContext {
  const { providerId, accountId } = agent.selection;
  const config = ctx.agents.configOf(agent.id);
  const models = () => modelsOf(ctx, providerId, accountId);
  return {
    profile: agent,
    config,
    projects: ctx.projects.filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name })),
    bots: ctx.agents.liveProfiles(),
    model: model => {
      const route = modelRoute(ctx, agent, model);
      if (route === null) return { ok: false, message: 'the provider does not offer this model' };
      const ref = `${route.providerId}/${route.model}`;
      // As the core: a model the settings do not allow yet is the owner's to allow by applying the card.
      if (!ctx.agents.accountAllowed(agent.id, route.accountId)) return { ok: false, message: `model: ${ref} runs on an account the owner has not granted ${agent.name}` };
      return { ok: true, value: ref };
    },
    effort: effort => {
      if (effort === null) return { ok: true, value: null };
      const levels = models().find(entry => entry.id === agent.selection.model)?.effort?.levels ?? [];
      return levels.some(level => level.id === effort) ? { ok: true, value: effort } : { ok: false, message: 'the model does not offer this reasoning effort' };
    },
  };
}

/** The agent setting cards open on a thread, one per agent and key. */
function openOn(ctx: FakeContext, threadId: string): AgentSettingAsk[] {
  return [...ctx.pendingQuestions.values()].flatMap(pending => (pending.request.threadId === threadId && pending.request.agentSetting ? [pending.request.agentSetting] : []));
}

/** `agents.settings.request` on a thread whose turn is known; the fake agent's `[agent-settings]` marker comes here too. */
export function requestAgentSetting(ctx: FakeContext, thread: Thread, turn: Turn, params: AgentSettingRequestParams): { questionId: string; setting: AgentSettingAsk } {
  const agent = agentFor(ctx, thread.id, params.agent);
  const checked = checkAgentSettingRequest(params, context(ctx, agent), openOn(ctx, thread.id));
  if (!checked.ok) throw refused(checked.message, checked.data);
  return { questionId: askAgentSetting(ctx, thread, turn, checked.reason, checked.options, checked.setting), setting: checked.setting };
}

/** Every open card the agents' settings now answer settles; one about a removed or archived agent closes. */
export function settleAgentSettings(ctx: FakeContext, agentId?: string): void {
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    const ask = pending.request.agentSetting;
    if (ask === undefined || (agentId !== undefined && ask.agentId !== agentId) || !ctx.pendingQuestions.has(questionId)) continue;
    const profile = ctx.agents.profileOf(ask.agentId);
    const answer = settledAgentSetting(ask, profile, profile && profile.status !== 'archived' ? ctx.agents.configOf(profile.id) : null);
    if (answer === null) continue;
    ctx.pendingQuestions.delete(questionId);
    pending.resolve(answer === 'close' ? null : answer);
  }
}

function write(ctx: FakeContext, agent: AgentProfile, key: AgentSettingAsk['key'], value: unknown): AgentProfile {
  const config = ctx.agents.configOf(agent.id);
  switch (key) {
    case 'name':
    case 'domain':
    case 'instructions':
    case 'avatar': return ctx.agents.writeSetting(agent.id, { profile: { [key]: value as string } });
    case 'status': return ctx.agents.writeSetting(agent.id, { profile: { status: value as AgentProfile['status'] } });
    case 'projects': return ctx.agents.writeSetting(agent.id, { projectIds: value as string[] });
    case 'model': {
      const { providerId, model } = agentModelRoute(value as string);
      const accountId = accountOn(ctx, agent, providerId);
      if (accountId === undefined) throw refused(`model: ${providerId} has no signed-in account on this machine`, { field: 'value', key });
      // A level the new model lacks goes back to its default rather than refusing the change.
      const levels = modelsOf(ctx, providerId, accountId).find(entry => entry.id === model)?.effort?.levels ?? [];
      const effort = agent.selection.effort !== null && levels.some(level => level.id === agent.selection.effort) ? agent.selection.effort : null;
      const selection = { ...agent.selection, providerId, accountId, model, effort };
      if (!ctx.agents.hasPolicy(agent.id)) return ctx.agents.writeSetting(agent.id, { selection });
      // As the core: applying the card allows the route in the agent's settings.
      const routes = config.allowedRoutes, ref = `${providerId}/${model}`;
      const listed = routes.some(route => route.providerId === providerId && route.accountId === accountId && route.model === model);
      const name = modelsOf(ctx, providerId, accountId).find(entry => entry.id === model)?.name ?? model;
      const allowedRoutes = listed ? routes : [...routes, { id: routes.some(route => route.id === ref) ? `${ref}-${routes.length + 1}` : ref, name, providerId, accountId, model, effort }];
      return ctx.agents.writeSetting(agent.id, { selection, config: { ...config, defaultRoute: selection, allowedRoutes } });
    }
    case 'effort': return ctx.agents.writeSetting(agent.id, { selection: { ...agent.selection, effort: value as string | null } });
    case 'autoMemory': return ctx.agents.writeSetting(agent.id, { config: { ...config, autoMemory: value as boolean } });
    case 'eventWakes': return ctx.agents.writeSetting(agent.id, { config: { ...config, eventWakes: value as boolean } });
    case 'subagents': return ctx.agents.writeSetting(agent.id, { config: { ...config, subagents: { ...config.subagents, enabled: value as boolean } } });
    case 'dailyBudget': return ctx.agents.writeSetting(agent.id, { config: { ...config, dailyBudgetUsd: value as number | null } });
  }
}

type Handlers = { [M in AgentSettingMethod]: (params: RpcParams<M>) => RpcResult<M> };

/** As the core's creation route: the calling thread's own, or the model named; effort only when asked, permissions as the Bots page. */
function createRoute(ctx: FakeContext, thread: Thread): AgentCreateContext['route'] {
  return (model, effort) => {
    try {
      const models = modelsOf(ctx, thread.providerId, thread.accountId);
      // A thread on its provider's default takes the model marked default, else the first, as the core does.
      const route = model === undefined
        ? { providerId: thread.providerId, accountId: thread.accountId, model: thread.model ?? models.find(entry => entry.default === true)?.id ?? models[0]?.id ?? null }
        : pickModel(ctx, thread, CREATE_ROUTES, model, effort);
      if (route.model === null) return { ok: false, message: 'model: this thread runs on its provider\'s default model; name one with --model' };
      if (model === undefined && effort !== undefined && !(modelsOf(ctx, route.providerId, route.accountId).find(entry => entry.id === route.model)?.effort?.levels ?? []).some(level => level.id === effort)) {
        return { ok: false, message: 'the model does not offer this reasoning effort' };
      }
      const selection: AgentSelection = { providerId: route.providerId, accountId: route.accountId, model: route.model, effort: effort ?? null, permissionMode: 'bypassPermissions' };
      return { ok: true, value: selection };
    } catch (error) {
      if (error instanceof RpcFailure) return { ok: false, message: error.message };
      throw error;
    }
  };
}

export function agentSettingMethods(ctx: FakeContext): Handlers {
  return {
    'agents.create': params => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw refused('an archived thread cannot create a bot', { threadId: thread.id });
      const checked = checkAgentCreate(params, {
        bots: ctx.agents.liveProfiles(),
        projects: ctx.projects.filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name })),
        route: createRoute(ctx, thread),
      });
      if (!checked.ok) throw refused(checked.message, checked.data);
      const { name, domain, instructions, projectIds, selection } = checked.value;
      const agent = ctx.agents.create({ name, domain, instructions, avatar: '', status: 'active', projectIds, selection });
      return { agent, threadId: ctx.agents.conversationOf(agent.id) };
    },
    'agents.settings.read': params => {
      ctx.thread(params.threadId);
      const agent = agentFor(ctx, params.threadId, params.agent);
      const checks = context(ctx, agent);
      const model = modelsOf(ctx, agent.selection.providerId, agent.selection.accountId).find(entry => entry.id === agent.selection.model);
      // As the core: its provider's models, then the current ones of each other provider signed in here.
      const providers = ctx.providers.filter(provider => provider.available && providerEnabled(provider))
        .sort((a, b) => Number(b.id === agent.selection.providerId) - Number(a.id === agent.selection.providerId));
      const models = providers.flatMap(provider => {
        const accountId = accountOn(ctx, agent, provider.id);
        const own = provider.id === agent.selection.providerId;
        return accountId === undefined ? [] : modelsOf(ctx, provider.id, accountId).filter(entry => own || !entry.legacy).map(entry => ({ id: `${provider.id}/${entry.id}`, label: entry.name }));
      });
      const settings = AGENT_SETTING_KEYS.map((key): AgentSettingReading => {
        const value = agentSettingValue(agent, checks.config, key);
        if (key === 'status') return { key, value, choices: AGENT_STATUSES.map(status => ({ id: status, label: status })) };
        if (key === 'projects') return { key, value, choices: [...checks.projects] };
        if (key === 'model') return { key, value, choices: models.filter(entry => checks.model(entry.id).ok) };
        if (key === 'effort' && model?.effort?.levels.length) return { key, value, choices: model.effort.levels.map(level => ({ id: level.id, label: level.label })) };
        return { key, value };
      });
      return { agentId: agent.id, agentName: agent.name, settings };
    },
    'agents.settings.request': params => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
      const turn = thread.turns.find(entry => entry.status === 'running') ?? thread.turns.at(-1);
      if (!turn) throw refused('the thread has no turn to ask in yet', { threadId: thread.id });
      return requestAgentSetting(ctx, thread, turn, params);
    },
    'agents.settings.apply': params => {
      const ask = ctx.pendingQuestions.get(params.questionId)?.request;
      if (ask?.threadId !== params.threadId || ask.agentSetting === undefined) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `agents.settings.apply: ${String(params.questionId)} is no open agent setting card of thread ${String(params.threadId)}`, data: { field: 'questionId' } });
      }
      const setting = ask.agentSetting;
      const agent = ctx.agents.profileOf(setting.agentId);
      if (!agent) throw refused(`unknown profile ${setting.agentId}`);
      if (agent.status === 'archived') throw refused(`agents.settings.apply: ${agent.name} is archived`, { field: 'questionId' });
      let value = setting.value;
      // As the core: a name is checked again, another card may have given it away since; a model too.
      if (params.value !== undefined || setting.key === 'name' || setting.key === 'model') {
        const normalized = normalizeAgentSetting(setting.key, params.value ?? agentSettingProposal(setting, agent), context(ctx, agent));
        if (!normalized.ok) throw refused(normalized.message, { field: 'value', key: setting.key });
        value = normalized.value;
      }
      const saved = write(ctx, agent, setting.key, value);
      settleAgentSettings(ctx, agent.id);
      return saved;
    },
  };
}
