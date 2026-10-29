/**
 * Agent setting cards: a thread, or a persistent agent about itself or another
 * bot, asks the user to change one of a bot's settings, such as its name or
 * a project entrusted to it.
 * The card is a question asked without stopping (threads/cards.ts); Apply is
 * the owner's `agents.settings.apply`, and any change to the agent, from the
 * card or from its settings page, settles the cards it answers. The outcome
 * reaches the thread that asked as a message, the way a `boite ask` answer
 * does, on an agent's thread as on any other. Shared checks live in
 * contracts/agent-setting-requests.ts, where the in-memory client reads them.
 */
import {
  agentModelRoute, agentSettingAnswerText, agentSettingProposal, agentSettingValue, AGENT_SETTING_KEYS, AGENT_STATUSES, checkAgentSettingRequest, normalizeAgentSetting, settledAgentSetting,
  type AgentProfile, type AgentSettingApplyParams, type AgentSettingAsk, type AgentSettingContext, type AgentSettingReading,
  type AccountId, type AgentSettingChoice, type AgentSettingRequestParams, type AgentSettingsReading, type AgentSettingsReadParams,
  type ProviderId, type QuestionAnswer, type RequestId,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { loggedInAccount } from '../delegation/routes.ts';
import { messageOf, notFound, refused, RpcFailure } from '../errors.ts';
import { agentProvider, checkEffort, checkModel, modelsFor } from '../threads/selection.ts';
import { remoteGrant } from './group-bots.ts';
import { sameRoute } from './resident.ts';
import type { AgentStore } from './store.ts';

export class AgentSettingCards {
  #scheduled = false;
  readonly #off: () => void;

  readonly #core: Core;
  readonly #store: AgentStore;

  constructor(core: Core, store: AgentStore) {
    this.#core = core;
    this.#store = store;
    // A change to any agent may answer a card. Settled after the change commits, once per burst.
    this.#off = core.bus.onAny(name => {
      if (name !== 'agents.changed' || this.#scheduled) return;
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        if (core.journal.isClosed()) return;
        try { this.settle(); } catch (error) { core.log('warn', `agent setting cards: ${messageOf(error)}`); }
      });
    });
  }

  close(): void { this.#off(); }

  /** The agent a call names, by id or name; unnamed, the agent whose thread, or whose subagent, the thread is. */
  #agentFor(threadId: string, name: string | undefined): AgentProfile {
    const live = this.#store.records.list('profile').filter(agent => agent.status !== 'archived');
    if (name === undefined || name.trim() === '') {
      const own = this.#store.resident.ownerOf(threadId);
      if (own !== null) return this.#store.records.get('profile', own);
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

  /** `refs`: a model is read as `<provider>/<model>` only, as a card holds it on Apply. */
  #context(agent: AgentProfile, refs = false): AgentSettingContext {
    const provider = agentProvider(this.#core, agent);
    const accountId = agent.selection.accountId;
    const checked = <T>(run: () => T): { ok: true; value: T } | { ok: false; message: string } => {
      try { return { ok: true, value: run() }; } catch (error) {
        if (error instanceof RpcFailure) return { ok: false, message: error.message };
        throw error;
      }
    };
    return {
      profile: agent,
      config: this.#store.resident.config(agent.id),
      projects: this.#projectChoices(agent),
      bots: this.#store.records.list('profile').filter(bot => bot.status !== 'archived'),
      model: model => checked(() => {
        const route = this.#modelRoute(agent, model, refs);
        const ref = `${route.providerId}/${route.model}`;
        // An account the owner granted to other bots stays theirs. A model its settings do not allow yet
        // is the owner's to allow, which applying the card does.
        if (!this.#store.resident.accountAllowed(agent.id, route.accountId)) throw refused(`model: ${ref} runs on an account the owner has not granted ${agent.name}`);
        return ref;
      }),
      effort: effort => checked(() => checkEffort(provider, accountId, agent.selection.model, effort)),
    };
  }

  /**
   * The route a model card names: `<provider>/<model>` of any installed
   * provider, or a model id of the agent's own, which may hold a slash itself
   * (`opencode/glm-5.3`). With `refs`, only the first.
   */
  #modelRoute(agent: AgentProfile, wanted: string, refs = false): { providerId: ProviderId; accountId: AccountId; model: string } {
    const own = agentProvider(this.#core, agent);
    const ownRoute = () => ({ providerId: own.id, accountId: agent.selection.accountId, model: checkModel(own, agent.selection.accountId, wanted)! });
    const slash = wanted.indexOf('/');
    const named = slash > 0 ? this.#core.providers.get(wanted.slice(0, slash)) : undefined;
    if (named === undefined) {
      if (refs) throw refused(`model: ${wanted} names no provider of this machine`, { field: 'model' });
      return ownRoute();
    }
    const model = wanted.slice(slash + 1);
    // Another provider must be installed and turned on: Apply would otherwise move the bot where its thread cannot follow.
    const usable = named.id === own.id || this.#core.providers.available().some(summary => summary.id === named.id);
    const accountId = usable ? this.#accountOn(agent, named.id) : undefined;
    if (accountId !== undefined && modelsFor(named, accountId).some(entry => entry.id === model)) return { providerId: named.id, accountId, model };
    // A drawn card's reference never falls back to an id of the agent's provider that reads the same.
    if (!refs && modelsFor(own, agent.selection.accountId).some(entry => entry.id === wanted)) return ownRoute();
    if (!usable) throw refused(`model: ${named.id} is not installed or is turned off on this machine`, { field: 'model', providerId: named.id });
    if (accountId === undefined) throw refused(`model: ${named.id} has no signed-in account on this machine`, { field: 'model', providerId: named.id });
    return { providerId: named.id, accountId, model: checkModel(named, accountId, model)! };
  }

  /** The agent's own login on its provider; on another, that provider's signed-in default. */
  #accountOn(agent: AgentProfile, providerId: ProviderId): AccountId | undefined {
    if (providerId === agent.selection.providerId) return agent.selection.accountId;
    return loggedInAccount(this.#core.accounts.list().filter(account => account.providerId === providerId))?.id;
  }

  /** Every model a card may move the agent to: its provider's, then the current ones of each other provider signed in here. */
  #modelChoices(agent: AgentProfile, ctx: AgentSettingContext): AgentSettingChoice[] {
    const providers = this.#core.providers.available().sort((a, b) => Number(b.id === agent.selection.providerId) - Number(a.id === agent.selection.providerId));
    return providers.flatMap(summary => {
      const accountId = this.#accountOn(agent, summary.id);
      if (accountId === undefined) return [];
      const own = summary.id === agent.selection.providerId;
      return modelsFor(this.#core.providers.require(summary.id), accountId).filter(model => own || !model.legacy)
        .map(model => ({ id: `${summary.id}/${model.id}`, label: model.name }));
    }).filter(choice => ctx.model(choice.id).ok);
  }

  /**
   * The projects of this machine, then those of the other machines of the
   * group as `<machine>/<name>`. One the bot holds stays a choice after its
   * machine left, so a card can take it away.
   */
  #projectChoices(agent: AgentProfile): AgentSettingContext['projects'] {
    const here = this.#core.projects.list().filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name }));
    const group = this.#store.group.choices();
    const held = (agent.projectIds ?? []).filter(id => remoteGrant(id) !== null && !group.some(choice => choice.id === id)).map(id => ({ id, label: this.#store.group.label(id) }));
    return [...here, ...group, ...held];
  }

  async read(params: AgentSettingsReadParams): Promise<AgentSettingsReading> {
    this.#core.threads.require(params.threadId);
    this.#agentFor(params.threadId, params.agent);
    // The other machines' projects, read fresh; one away keeps the names it gave last.
    await this.#store.group.refresh();
    const agent = this.#agentFor(params.threadId, params.agent);
    const ctx = this.#context(agent);
    const model = modelsFor(agentProvider(this.#core, agent), agent.selection.accountId).find(m => m.id === agent.selection.model);
    const settings = AGENT_SETTING_KEYS.map((key): AgentSettingReading => {
      const value = agentSettingValue(agent, ctx.config, key);
      if (key === 'status') return { key, value, choices: AGENT_STATUSES.map(status => ({ id: status, label: status })) };
      if (key === 'projects') return { key, value, choices: [...ctx.projects] };
      if (key === 'model') return { key, value, choices: this.#modelChoices(agent, ctx) };
      if (key === 'effort' && model?.effort?.levels.length) return { key, value, choices: model.effort.levels.map(level => ({ id: level.id, label: level.label })) };
      return { key, value };
    });
    return { agentId: agent.id, agentName: agent.name, settings };
  }

  /** The cards open on a thread, one per agent and key. */
  #openOn(threadId: string): AgentSettingAsk[] {
    return this.#core.threads.listQuestions(threadId).flatMap(request => (request.agentSetting ? [request.agentSetting] : []));
  }

  async request(params: AgentSettingRequestParams): Promise<{ questionId: RequestId; setting: AgentSettingAsk }> {
    const thread = this.#core.threads.require(params.threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
    const agent = this.#agentFor(thread.id, params.agent);
    if (params.key === 'projects') await this.#store.group.refresh();
    // The card is drawn against the profile as it stands now: the owner may have changed it while the machines answered.
    const checked = checkAgentSettingRequest(params, this.#context(params.key === 'projects' ? this.#agentFor(thread.id, params.agent) : agent), this.#openOn(thread.id));
    if (!checked.ok) throw refused(checked.message, checked.data);
    const { reason, setting, options } = checked;
    const { questionId } = this.#core.threads.cards.drawAsync(thread, { text: reason, options, allowText: false, multiple: false, async: true, agentSetting: setting });
    return { questionId, setting };
  }

  /** The owner applies a card, or their edit of it: the change goes through the agent's own settings. */
  apply(params: AgentSettingApplyParams): AgentProfile {
    const request = this.#core.threads.listQuestions(params.threadId).find(question => question.id === params.questionId);
    const ask = request?.agentSetting;
    if (ask === undefined) throw notFound(`agents.settings.apply: ${String(params.questionId)} is no open agent setting card of thread ${String(params.threadId)}`, { field: 'questionId' });
    const agent = this.#store.records.get('profile', ask.agentId);
    if (agent.status === 'archived') throw refused(`agents.settings.apply: ${agent.name} is archived`, { field: 'questionId' });
    const ctx = this.#context(agent, true);
    let value = ask.value;
    // A name is checked again: another card may have given it to a bot since this one was drawn.
    // A model too: its provider may have signed out or been turned off.
    if (params.value !== undefined || ask.key === 'name' || ask.key === 'model') {
      const normalized = normalizeAgentSetting(ask.key, params.value ?? agentSettingProposal(ask, agent), ctx);
      if (!normalized.ok) throw refused(normalized.message, { field: 'value', key: ask.key });
      value = normalized.value;
    }
    const saved = this.#write(agent, ctx, ask.key, value);
    this.settle(agent.id);
    return saved;
  }

  #write(agent: AgentProfile, ctx: AgentSettingContext, key: AgentSettingAsk['key'], value: unknown): AgentProfile {
    const save = (next: AgentProfile) => this.#store.saveProfile({ id: agent.id, expectedRevision: agent.revision, value: next });
    const configure = (config: AgentSettingContext['config']) => this.#store.resident.configure({ agentId: agent.id, expectedRevision: agent.revision, config });
    switch (key) {
      case 'name':
      case 'domain':
      case 'instructions':
      case 'avatar': return save({ ...agent, [key]: value as string });
      case 'status': return save({ ...agent, status: value as AgentProfile['status'] });
      case 'projects': return save({ ...agent, projectIds: value as string[] });
      case 'model': {
        // Another provider runs on its signed-in default login; the agent keeps its own on its provider.
        const { providerId, model } = agentModelRoute(value as string);
        const accountId = this.#accountOn(agent, providerId);
        if (accountId === undefined) throw refused(`model: ${providerId} has no signed-in account on this machine`, { field: 'value', key });
        // A level the new model lacks goes back to its default rather than refusing the change.
        const provider = this.#core.providers.require(providerId);
        let effort: string | null = null;
        try { effort = checkEffort(provider, accountId, model, agent.selection.effort); } catch { /* The model's default level. */ }
        const selection = { ...agent.selection, providerId, accountId, model, effort };
        if (!this.#core.journal.getSetting(`agents:runtime:${agent.id}`)) return save({ ...agent, selection });
        // Applying the card is the owner allowing the model: it joins the routes the bot's settings allow.
        const routes = ctx.config.allowedRoutes;
        if (routes.some(route => sameRoute(route, selection))) return configure({ ...ctx.config, defaultRoute: selection });
        const ref = `${providerId}/${model}`;
        let id = ref.slice(0, 64);
        for (let n = 2; routes.some(route => route.id === id); n++) id = `${ref.slice(0, 60)}-${n}`;
        const name = (modelsFor(provider, accountId).find(entry => entry.id === model)?.name ?? model).slice(0, 100);
        return configure({ ...ctx.config, defaultRoute: selection, allowedRoutes: [...routes, { id, name, providerId, accountId, model, effort }] });
      }
      case 'effort': return save({ ...agent, selection: { ...agent.selection, effort: value as string | null } });
      case 'autoMemory': return configure({ ...ctx.config, autoMemory: value as boolean });
      case 'eventWakes': return configure({ ...ctx.config, eventWakes: value as boolean });
      case 'subagents': return configure({ ...ctx.config, subagents: { ...ctx.config.subagents, enabled: value as boolean } });
      case 'dailyBudget': return configure({ ...ctx.config, dailyBudgetUsd: value as number | null });
    }
  }

  /** Every open card the agent's settings now answer settles; one about a removed or archived agent closes. */
  settle(agentId?: string): void {
    this.#core.threads.cards.settle(request => {
      const ask = request.agentSetting;
      if (ask === undefined || (agentId !== undefined && ask.agentId !== agentId)) return null;
      let profile: AgentProfile | null = null;
      try { profile = this.#store.records.get('profile', ask.agentId); } catch { /* Removed: the card closes. */ }
      return settledAgentSetting(ask, profile, profile && profile.status !== 'archived' ? this.#store.resident.config(profile.id) : null);
    }, "a change to the agent's settings");
  }

  /** What the asking thread reads, projects by name. */
  answerText(setting: AgentSettingAsk, answer: QuestionAnswer): string {
    const names = new Map(this.#core.projects.list().map(project => [project.id, project.name]));
    const label = (id: string): string => names.get(id) ?? setting.labels?.[id] ?? this.#store.group.label(id);
    return agentSettingAnswerText(setting, answer, value => JSON.stringify(setting.key === 'projects' && Array.isArray(value) ? value.map(id => label(String(id))) : value ?? null));
  }
}

export function registerAgentSettingMethods(core: Core, cards: AgentSettingCards): void {
  core.router.register('agents.settings.read', p => cards.read(p));
  core.router.register('agents.settings.request', p => cards.request(p));
  core.router.register('agents.settings.apply', p => cards.apply(p));
}
