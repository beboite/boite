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
  agentSettingAnswerText, agentSettingValue, AGENT_SETTING_KEYS, AGENT_STATUSES, checkAgentSettingRequest, normalizeAgentSetting, settledAgentSetting,
  type AgentProfile, type AgentSettingApplyParams, type AgentSettingAsk, type AgentSettingContext, type AgentSettingReading,
  type AgentSettingRequestParams, type AgentSettingsReading, type AgentSettingsReadParams, type QuestionAnswer, type RequestId,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf, notFound, refused, RpcFailure } from '../errors.ts';
import { agentProvider, checkEffort, checkModel, modelsFor } from '../threads/selection.ts';
import { remoteGrant } from './group-bots.ts';
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
      projects: this.projectChoices(agent),
      bots: this.store.records.list('profile').filter(bot => bot.status !== 'archived'),
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

  /**
   * The projects of this machine, then those of the other machines of the
   * group as `<machine>/<name>`. One the bot holds stays a choice after its
   * machine left, so a card can take it away.
   */
  private projectChoices(agent: AgentProfile): AgentSettingContext['projects'] {
    const here = this.core.projects.list().filter(project => project.kind !== 'drafts').map(project => ({ id: project.id, label: project.name }));
    const group = this.store.group.choices();
    const held = (agent.projectIds ?? []).filter(id => remoteGrant(id) !== null && !group.some(choice => choice.id === id)).map(id => ({ id, label: this.store.group.label(id) }));
    return [...here, ...group, ...held];
  }

  async read(params: AgentSettingsReadParams): Promise<AgentSettingsReading> {
    this.core.threads.require(params.threadId);
    this.agentFor(params.threadId, params.agent);
    // The other machines' projects, read fresh; one away keeps the names it gave last.
    await this.store.group.refresh();
    const agent = this.agentFor(params.threadId, params.agent);
    const ctx = this.context(agent);
    const provider = agentProvider(this.core, agent);
    const models = modelsFor(provider, agent.selection.accountId);
    const model = models.find(m => m.id === agent.selection.model);
    const settings = AGENT_SETTING_KEYS.map((key): AgentSettingReading => {
      const value = agentSettingValue(agent, ctx.config, key);
      if (key === 'status') return { key, value, choices: AGENT_STATUSES.map(status => ({ id: status, label: status })) };
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

  async request(params: AgentSettingRequestParams): Promise<{ questionId: RequestId; setting: AgentSettingAsk }> {
    const thread = this.core.threads.require(params.threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
    const agent = this.agentFor(thread.id, params.agent);
    if (params.key === 'projects') await this.store.group.refresh();
    // The card is drawn against the profile as it stands now: the owner may have changed it while the machines answered.
    const checked = checkAgentSettingRequest(params, this.context(params.key === 'projects' ? this.agentFor(thread.id, params.agent) : agent), this.openOn(thread.id));
    if (!checked.ok) throw refused(checked.message, checked.data);
    const { reason, setting, options } = checked;
    const { questionId } = this.core.threads.cards.drawAsync(thread, { text: reason, options, allowText: false, multiple: false, async: true, agentSetting: setting });
    return { questionId, setting };
  }

  /** The owner applies a card, or their edit of it: the change goes through the agent's own settings. */
  apply(params: AgentSettingApplyParams): AgentProfile {
    const request = this.core.threads.listQuestions(params.threadId).find(question => question.id === params.questionId);
    const ask = request?.agentSetting;
    if (ask === undefined) throw notFound(`agents.settings.apply: ${String(params.questionId)} is no open agent setting card of thread ${String(params.threadId)}`, { field: 'questionId' });
    const agent = this.store.records.get('profile', ask.agentId);
    if (agent.status === 'archived') throw refused(`agents.settings.apply: ${agent.name} is archived`, { field: 'questionId' });
    const ctx = this.context(agent);
    let value = ask.value;
    // A name is checked again: another card may have given it to a bot since this one was drawn.
    if (params.value !== undefined || ask.key === 'name') {
      const normalized = normalizeAgentSetting(ask.key, params.value ?? ask.value, ctx);
      if (!normalized.ok) throw refused(normalized.message, { field: 'value', key: ask.key });
      value = normalized.value;
    }
    const saved = this.write(agent, ctx, ask.key, value);
    this.settle(agent.id);
    return saved;
  }

  private write(agent: AgentProfile, ctx: AgentSettingContext, key: AgentSettingAsk['key'], value: unknown): AgentProfile {
    const save = (next: AgentProfile) => this.store.saveProfile({ id: agent.id, expectedRevision: agent.revision, value: next });
    const configure = (config: AgentSettingContext['config']) => this.store.resident.configure({ agentId: agent.id, expectedRevision: agent.revision, config });
    switch (key) {
      case 'name':
      case 'domain':
      case 'instructions':
      case 'avatar': return save({ ...agent, [key]: value as string });
      case 'status': return save({ ...agent, status: value as AgentProfile['status'] });
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
      case 'eventWakes': return configure({ ...ctx.config, eventWakes: value as boolean });
      case 'subagents': return configure({ ...ctx.config, subagents: { ...ctx.config.subagents, enabled: value as boolean } });
      case 'dailyBudget': return configure({ ...ctx.config, dailyBudgetUsd: value as number | null });
    }
  }

  /** Every open card the agent's settings now answer settles; one about a removed or archived agent closes. */
  settle(agentId?: string): void {
    this.core.threads.cards.settle(request => {
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
    const label = (id: string): string => names.get(id) ?? setting.labels?.[id] ?? this.store.group.label(id);
    return agentSettingAnswerText(setting, answer, value => JSON.stringify(setting.key === 'projects' && Array.isArray(value) ? value.map(id => label(String(id))) : value ?? null));
  }
}

export function registerAgentSettingMethods(core: Core, cards: AgentSettingCards): void {
  core.router.register('agents.settings.read', p => cards.read(p));
  core.router.register('agents.settings.request', p => cards.request(p));
  core.router.register('agents.settings.apply', p => cards.apply(p));
}
