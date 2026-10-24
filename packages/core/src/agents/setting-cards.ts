/**
 * Agent setting cards: a thread, or a persistent agent about itself, asks the
 * user to change one of an agent's settings, such as entrusting it a project.
 * The card is a question asked without stopping (threads/cards.ts); Apply is
 * the owner's `agents.settings.apply`, and any change to the agent, from the
 * card or from its settings page, settles the cards it answers. The outcome
 * reaches the thread that asked as a message, the way a `boite ask` answer
 * does, on an agent's thread as on any other. A creation card proposes a new
 * bot the same way: Apply creates it, and its appearance settles the card.
 * Shared checks live in contracts/agent-setting-requests.ts and
 * contracts/agent-create-requests.ts, where the in-memory client reads them.
 */
import {
  agentCreateAnswerText, agentSettingAnswerText, agentSettingValue, AGENT_SETTING_KEYS, checkAgentCreateRequest, checkAgentSettingRequest, normalizeAgentSetting,
  settledAgentCreate, settledAgentSetting,
  type AgentCreateAsk, type AgentCreateRequestParams, type AgentProfile, type AgentSettingApplyParams, type AgentSettingAsk, type AgentSettingContext,
  type AgentSettingReading, type AgentSettingRequestParams, type AgentSettingsReading, type AgentSettingsReadParams, type DelegationConfig,
  type QuestionAnswer, type RequestId,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { resolveRoute } from '../delegation/routes.ts';
import { messageOf, notFound, refused, RpcFailure } from '../errors.ts';
import { agentProvider, checkEffort, checkModel, modelsFor } from '../threads/selection.ts';
import type { AgentStore } from './store.ts';

export class AgentSettingCards {
  private scheduled = false;
  private readonly off: () => void;

  constructor(private readonly core: Core, private readonly store: AgentStore) {
    // A change to any agent may answer a card. Settled after the change commits, once per burst.
    this.off = core.bus.onAny(name => {
      if (name !== 'agents.changed' || this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (core.journal.isClosed()) return;
        try { this.settle(); } catch (error) { core.log('warn', `agent setting cards: ${messageOf(error)}`); }
      });
    });
  }

  close(): void { this.off(); }

  /** The agent a call names, by id or name; unnamed, the agent whose thread, or whose subagent, the thread is. */
  private agentFor(threadId: string, name: string | undefined): AgentProfile {
    const live = this.store.records.list('profile').filter(agent => agent.status !== 'archived');
    if (name === undefined || name.trim() === '') {
      const own = this.store.resident.ownerOf(threadId);
      if (own !== null) return this.store.records.get('profile', own);
      throw refused(`agent: this thread is no bot's conversation; name one: ${live.map(agent => agent.name).join(', ') || 'there are no bots yet'}`, { field: 'agent' });
    }
    const wanted = name.trim();
    const byId = live.find(agent => agent.id === wanted);
    if (byId !== undefined) return byId;
    const named = live.filter(agent => agent.name.toLowerCase() === wanted.toLowerCase());
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw refused(`agent: ${named.length} bots are named ${JSON.stringify(wanted)}; name it by id: ${named.map(agent => agent.id).join(', ')}`, { field: 'agent' });
    throw refused(`agent: no bot ${JSON.stringify(wanted)}; the bots are ${live.map(agent => agent.name).join(', ') || 'none yet'}`, { field: 'agent', expected: live.map(agent => agent.name) });
  }

  private context(agent: AgentProfile): AgentSettingContext {
    const provider = agentProvider(this.core, agent);
    const accountId = agent.selection.accountId;
    const checked = <T>(run: () => T): { ok: true; value: T } | { ok: false; message: string } => {
      try { return { ok: true, value: run() }; } catch (error) {
        if (error instanceof RpcFailure) return { ok: false, message: error.message };
        throw error;
      }
    };
    return {
      profile: agent,
      config: this.store.resident.config(agent.id),
      projects: this.core.projects.list().filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name })),
      model: model => checked(() => {
        const kept = checkModel(provider, accountId, model);
        if (kept === null) throw refused('model: expected a model id');
        // The same test `agents.profile.save` makes once the owner set a policy.
        if (this.core.journal.getSetting(`agents:runtime:${agent.id}`) && !this.store.resident.allowed(agent.id, { ...agent.selection, model: kept })) {
          throw refused(`model: ${kept} is not among the models ${agent.name} may use; the owner allows models in its settings`);
        }
        return kept;
      }),
      effort: effort => checked(() => checkEffort(provider, accountId, agent.selection.model, effort)),
    };
  }

  read(params: AgentSettingsReadParams): AgentSettingsReading {
    this.core.threads.require(params.threadId);
    const agent = this.agentFor(params.threadId, params.agent);
    const ctx = this.context(agent);
    const provider = agentProvider(this.core, agent);
    const models = modelsFor(provider, agent.selection.accountId);
    const model = models.find(m => m.id === agent.selection.model);
    const settings = AGENT_SETTING_KEYS.map((key): AgentSettingReading => {
      const value = agentSettingValue(agent, ctx.config, key);
      if (key === 'projects') return { key, value, choices: [...ctx.projects] };
      if (key === 'model') return { key, value, choices: models.filter(m => ctx.model(m.id).ok).map(m => ({ id: m.id, label: m.name })) };
      if (key === 'effort' && model?.effort?.levels.length) return { key, value, choices: model.effort.levels.map(level => ({ id: level.id, label: level.label })) };
      return { key, value };
    });
    return { agentId: agent.id, agentName: agent.name, settings };
  }

  /** The cards open on a thread, one per agent and key. */
  private openOn(threadId: string): AgentSettingAsk[] {
    return this.core.threads.listQuestions(threadId).flatMap(request => (request.agentSetting ? [request.agentSetting] : []));
  }

  request(params: AgentSettingRequestParams): { questionId: RequestId; setting: AgentSettingAsk } {
    const thread = this.core.threads.require(params.threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
    const agent = this.agentFor(thread.id, params.agent);
    const checked = checkAgentSettingRequest(params, this.context(agent), this.openOn(thread.id));
    if (!checked.ok) throw refused(checked.message, checked.data);
    const { reason, setting, options } = checked;
    const { questionId } = this.core.threads.cards.drawAsync(thread, { text: reason, options, allowText: false, multiple: false, async: true, agentSetting: setting });
    return { questionId, setting };
  }

  private liveBots(): AgentProfile[] {
    return this.store.records.list('profile').filter(agent => agent.status !== 'archived');
  }

  /**
   * A card proposing a new bot. Its route resolves as `boite delegate` reads a
   * model, from the asking thread: its own route when none is named. A new bot
   * starts with full access, as the Agents page creates one.
   */
  create(params: AgentCreateRequestParams): { questionId: RequestId; create: AgentCreateAsk } {
    const thread = this.core.threads.require(params.threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
    const open = this.core.threads.listQuestions(thread.id).flatMap(request => (request.agentCreate ? [request.agentCreate] : []));
    const checked = checkAgentCreateRequest(params, {
      bots: this.liveBots(),
      projects: this.core.projects.list().filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name })),
      route: (model, effort) => {
        try {
          const route = resolveRoute(this.core, thread, CREATE_ROUTES, { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });
          const provider = this.core.providers.require(route.providerId);
          // As `agents.profile.save` fills a route on the provider's default model.
          const chosen = checkModel(provider, route.accountId, route.model ?? provider.models.find(m => m.default)?.id ?? provider.models[0]?.id ?? null);
          if (chosen === null) return { ok: false, message: 'model: this thread runs on its provider\'s default model; name one with --model' };
          return { ok: true, value: { providerId: route.providerId, accountId: route.accountId, model: chosen, effort: effort === undefined ? null : route.effort, permissionMode: 'bypassPermissions' } };
        } catch (error) {
          if (error instanceof RpcFailure) return { ok: false, message: error.message };
          throw error;
        }
      },
    }, open);
    if (!checked.ok) throw refused(checked.message, checked.data);
    const { reason, create, options } = checked;
    const { questionId } = this.core.threads.cards.drawAsync(thread, { text: reason, options, allowText: false, multiple: false, async: true, agentCreate: create });
    return { questionId, create };
  }

  /** The owner applies a card, or their edit of it: the change goes through the agent's own settings. A creation card creates the bot. */
  apply(params: AgentSettingApplyParams): AgentProfile {
    const request = this.core.threads.listQuestions(params.threadId).find(question => question.id === params.questionId);
    if (request?.agentCreate !== undefined) return this.createBot(request.agentCreate);
    const ask = request?.agentSetting;
    if (ask === undefined) throw notFound(`agents.settings.apply: ${String(params.questionId)} is no open agent setting card of thread ${String(params.threadId)}`, { field: 'questionId' });
    const agent = this.store.records.get('profile', ask.agentId);
    if (agent.status === 'archived') throw refused(`agents.settings.apply: ${agent.name} is archived`, { field: 'questionId' });
    const ctx = this.context(agent);
    let value = ask.value;
    if (params.value !== undefined) {
      const normalized = normalizeAgentSetting(ask.key, params.value, ctx);
      if (!normalized.ok) throw refused(normalized.message, { field: 'value', key: ask.key });
      value = normalized.value;
    }
    const saved = this.write(agent, ctx, ask.key, value);
    this.settle(agent.id);
    return saved;
  }

  private createBot(create: AgentCreateAsk): AgentProfile {
    const taken = settledAgentCreate(create, this.liveBots());
    if (taken !== null) throw refused(`agents.settings.apply: a bot named ${JSON.stringify(create.name)} already exists (${String(taken.value)})`, { field: 'questionId' });
    const saved = this.store.saveProfile({ value: { name: create.name, domain: create.domain, instructions: create.instructions, avatar: '', status: 'active', projectIds: create.projectIds, selection: create.selection } });
    this.settle();
    return saved;
  }

  private write(agent: AgentProfile, ctx: AgentSettingContext, key: AgentSettingAsk['key'], value: unknown): AgentProfile {
    const save = (next: AgentProfile) => this.store.saveProfile({ id: agent.id, expectedRevision: agent.revision, value: next });
    const configure = (config: AgentSettingContext['config']) => this.store.resident.configure({ agentId: agent.id, expectedRevision: agent.revision, config });
    switch (key) {
      case 'projects': return save({ ...agent, projectIds: value as string[] });
      case 'model': {
        const provider = agentProvider(this.core, agent);
        // A level the new model lacks goes back to its default rather than refusing the change.
        let effort: string | null = null;
        try { effort = checkEffort(provider, agent.selection.accountId, value as string, agent.selection.effort); } catch { /* The model's default level. */ }
        return save({ ...agent, selection: { ...agent.selection, model: value as string, effort } });
      }
      case 'effort': return save({ ...agent, selection: { ...agent.selection, effort: value as string | null } });
      case 'autoMemory': return configure({ ...ctx.config, autoMemory: value as boolean });
      case 'subagents': return configure({ ...ctx.config, subagents: { ...ctx.config.subagents, enabled: value as boolean } });
      case 'dailyBudget': return configure({ ...ctx.config, dailyBudgetUsd: value as number | null });
    }
  }

  /**
   * Every open card the agents' settings now answer settles; one about a
   * removed or archived agent closes. A creation card settles once a bot of its
   * name exists.
   */
  settle(agentId?: string): void {
    let bots: AgentProfile[] | null = null;
    this.core.threads.cards.settle(request => {
      if (request.agentCreate !== undefined) return settledAgentCreate(request.agentCreate, bots ??= this.liveBots());
      const ask = request.agentSetting;
      if (ask === undefined || (agentId !== undefined && ask.agentId !== agentId)) return null;
      let profile: AgentProfile | null = null;
      try { profile = this.store.records.get('profile', ask.agentId); } catch { /* Removed: the card closes. */ }
      return settledAgentSetting(ask, profile, profile && profile.status !== 'archived' ? this.store.resident.config(profile.id) : null);
    }, "a change to the agent's settings");
  }

  /** What the asking thread reads, projects by name. */
  answerText(setting: AgentSettingAsk, answer: QuestionAnswer): string {
    const names = new Map(this.core.projects.list().map(project => [project.id, project.name]));
    return agentSettingAnswerText(setting, answer, value => JSON.stringify(setting.key === 'projects' && Array.isArray(value) ? value.map(id => names.get(String(id)) ?? id) : value ?? null));
  }

  /** What the asking thread reads once its creation card settles, the new bot's conversation included. */
  createAnswerText(create: AgentCreateAsk, answer: QuestionAnswer): string {
    const threadId = answer.optionIds[0] === 'created' ? this.store.sessionOf(String(answer.value))?.threadId ?? null : null;
    return agentCreateAnswerText(create, answer, threadId);
  }
}

/** Any installed model, as a subagent with no limits would read it: a bot's own policy comes later, from the owner. */
const CREATE_ROUTES: DelegationConfig = { enabled: true, paused: false, profiles: [], anyModel: true };

export function registerAgentSettingMethods(core: Core, cards: AgentSettingCards): void {
  core.router.register('agents.settings.read', p => cards.read(p));
  core.router.register('agents.settings.request', p => cards.request(p));
  core.router.register('agents.settings.apply', p => cards.apply(p));
}
