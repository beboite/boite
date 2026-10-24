/**
 * Agent setting cards on the in-memory client, as `packages/core/src/agents/setting-cards.ts`
 * draws them: a thread, or a persistent agent about itself, asks the user to
 * change one of an agent's settings; Apply writes it through the agent's own
 * settings, and any change to the agent settles the cards it answers. A
 * creation card proposes a new bot, which Apply creates.
 */
import {
  AGENT_SETTING_KEYS, RpcErrorCode, agentSettingValue, checkAgentCreateRequest, checkAgentSettingRequest, normalizeAgentSetting, settledAgentCreate, settledAgentSetting,
  type AgentCreateAsk, type AgentProfile, type AgentSelection, type AgentSettingAsk, type AgentSettingContext, type AgentSettingReading, type AgentSettingRequestParams,
  type AgentCreateContext, type DelegationConfig, type RpcParams, type RpcResult, type Thread, type Turn,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import type { AgentSettingMethod } from '../fake-agents';
import type { FakeContext } from './context';
import { pickModel } from './delegation';
import { modelsOf } from './provider-catalog';
import { askAgentCreate, askAgentSetting } from './requests';

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

function context(ctx: FakeContext, agent: AgentProfile): AgentSettingContext {
  const { providerId, accountId } = agent.selection;
  const config = ctx.agents.configOf(agent.id);
  const models = () => modelsOf(ctx, providerId, accountId);
  return {
    profile: agent,
    config,
    projects: ctx.projects.filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name })),
    model: model => {
      if (!models().some(entry => entry.id === model)) return { ok: false, message: 'the provider does not offer this model' };
      // The same test `agents.profile.save` makes once the owner set a policy.
      if (ctx.agents.hasPolicy(agent.id) && !config.allowedRoutes.some(route => route.providerId === providerId && route.accountId === accountId && route.model === model)) {
        return { ok: false, message: `model: ${model} is not among the models ${agent.name} may use; the owner allows models in its settings` };
      }
      return { ok: true, value: model };
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
  let bots: AgentProfile[] | null = null;
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    if (!ctx.pendingQuestions.has(questionId)) continue;
    // A creation card settles once a bot of its name exists, made from it or on the Agents page.
    const create = pending.request.agentCreate;
    if (create !== undefined) {
      const made = settledAgentCreate(create, bots ??= ctx.agents.liveProfiles());
      if (made === null) continue;
      ctx.pendingQuestions.delete(questionId);
      pending.resolve(made);
      continue;
    }
    const ask = pending.request.agentSetting;
    if (ask === undefined || (agentId !== undefined && ask.agentId !== agentId)) continue;
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
    case 'projects': return ctx.agents.writeSetting(agent.id, { projectIds: value as string[] });
    case 'model': {
      // A level the new model lacks goes back to its default rather than refusing the change.
      const levels = modelsOf(ctx, agent.selection.providerId, agent.selection.accountId).find(entry => entry.id === value)?.effort?.levels ?? [];
      const effort = agent.selection.effort !== null && levels.some(level => level.id === agent.selection.effort) ? agent.selection.effort : null;
      return ctx.agents.writeSetting(agent.id, { selection: { ...agent.selection, model: value as string, effort } });
    }
    case 'effort': return ctx.agents.writeSetting(agent.id, { selection: { ...agent.selection, effort: value as string | null } });
    case 'autoMemory': return ctx.agents.writeSetting(agent.id, { config: { ...config, autoMemory: value as boolean } });
    case 'subagents': return ctx.agents.writeSetting(agent.id, { config: { ...config, subagents: { ...config.subagents, enabled: value as boolean } } });
    case 'dailyBudget': return ctx.agents.writeSetting(agent.id, { config: { ...config, dailyBudgetUsd: value as number | null } });
  }
}

type Handlers = { [M in AgentSettingMethod]: (params: RpcParams<M>) => RpcResult<M> };

/** As the core's creation route: the asking thread's own, or the model named; effort only when asked, permissions as the Agents page. */
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

function createBot(ctx: FakeContext, create: AgentCreateAsk): AgentProfile {
  const taken = settledAgentCreate(create, ctx.agents.liveProfiles());
  if (taken !== null) throw refused(`agents.settings.apply: a bot named ${JSON.stringify(create.name)} already exists (${String(taken.value)})`, { field: 'questionId' });
  const saved = ctx.agents.create({ name: create.name, domain: create.domain, instructions: create.instructions, avatar: '', status: 'active', projectIds: create.projectIds, selection: create.selection });
  settleAgentSettings(ctx);
  return saved;
}

export function agentSettingMethods(ctx: FakeContext): Handlers {
  return {
    'agents.settings.read': params => {
      ctx.thread(params.threadId);
      const agent = agentFor(ctx, params.threadId, params.agent);
      const checks = context(ctx, agent);
      const models = modelsOf(ctx, agent.selection.providerId, agent.selection.accountId);
      const model = models.find(entry => entry.id === agent.selection.model);
      const settings = AGENT_SETTING_KEYS.map((key): AgentSettingReading => {
        const value = agentSettingValue(agent, checks.config, key);
        if (key === 'projects') return { key, value, choices: [...checks.projects] };
        if (key === 'model') return { key, value, choices: models.filter(entry => checks.model(entry.id).ok).map(entry => ({ id: entry.id, label: entry.name })) };
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
    'agents.settings.create': params => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
      const turn = thread.turns.find(entry => entry.status === 'running') ?? thread.turns.at(-1);
      if (!turn) throw refused('the thread has no turn to ask in yet', { threadId: thread.id });
      const open = [...ctx.pendingQuestions.values()].flatMap(pending => (pending.request.threadId === thread.id && pending.request.agentCreate ? [pending.request.agentCreate] : []));
      const checked = checkAgentCreateRequest(params, {
        bots: ctx.agents.liveProfiles(),
        projects: ctx.projects.filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name })),
        route: createRoute(ctx, thread),
      }, open);
      if (!checked.ok) throw refused(checked.message, checked.data);
      return { questionId: askAgentCreate(ctx, thread, turn, checked.reason, checked.options, checked.create), create: checked.create };
    },
    'agents.settings.apply': params => {
      const ask = ctx.pendingQuestions.get(params.questionId)?.request;
      if (ask?.threadId === params.threadId && ask.agentCreate !== undefined) return createBot(ctx, ask.agentCreate);
      if (ask?.threadId !== params.threadId || ask.agentSetting === undefined) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `agents.settings.apply: ${String(params.questionId)} is no open agent setting card of thread ${String(params.threadId)}`, data: { field: 'questionId' } });
      }
      const setting = ask.agentSetting;
      const agent = ctx.agents.profileOf(setting.agentId);
      if (!agent) throw refused(`unknown profile ${setting.agentId}`);
      if (agent.status === 'archived') throw refused(`agents.settings.apply: ${agent.name} is archived`, { field: 'questionId' });
      let value = setting.value;
      if (params.value !== undefined) {
        const normalized = normalizeAgentSetting(setting.key, params.value, context(ctx, agent));
        if (!normalized.ok) throw refused(normalized.message, { field: 'value', key: setting.key });
        value = normalized.value;
      }
      const saved = write(ctx, agent, setting.key, value);
      settleAgentSettings(ctx, agent.id);
      return saved;
    },
  };
}
