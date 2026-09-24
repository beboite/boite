import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type {
  AgentDraft, AgentEntities, AgentEntityKind, AgentProfile, AgentGroup, AgentTeam,
  AgentMission, AgentMissionTask, AgentSave, AgentScope, AgentMemory, AgentResource,
  AgentWork, AgentSession, AgentsSnapshot, RpcParams,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { newId } from '../ids.ts';
import { existingInside } from '../workdir.ts';
import { checkModel, checkEffort } from '../threads.ts';
import { AgentsRepository } from './repository.ts';
import { ResidentAgents } from './resident.ts';
import { AgentRoutines } from './routines.ts';
import { boolean, ids, integer, object, oneOf, sameScope, scope, text } from './validation.ts';

const DEFAULT_LIMITS: AgentsSnapshot['limits'] = { backgroundConcurrency: 2, paused: false, kebaccExperiment: false };
const TOOLS = ['messages', 'missions', 'memory', 'artifacts', 'decisions', 'routines'] as const;

export class AgentStore {
  readonly resident: ResidentAgents;
  readonly routines: AgentRoutines;
  readonly records: AgentsRepository;
  constructor(readonly core: Core) { this.records = new AgentsRepository(core.journal); this.resident = new ResidentAgents(core); this.routines = new AgentRoutines(core); }

  changed(): void { this.core.bus.emit('agents.changed', { revision: this.records.revision() }); }
  limits(): AgentsSnapshot['limits'] { return (this.core.journal.getSetting('agents:limits') as AgentsSnapshot['limits'] | undefined) ?? { ...DEFAULT_LIMITS }; }
  setLimits(value: AgentsSnapshot['limits']): AgentsSnapshot['limits'] {
    object(value, 'limits');
    const next = { backgroundConcurrency: integer(value.backgroundConcurrency, 'backgroundConcurrency', 1, 8), paused: boolean(value.paused, 'paused'), kebaccExperiment: boolean(value.kebaccExperiment, 'kebaccExperiment') };
    this.core.journal.append({ type: 'agents.limits', threadId: null, version: 1, payload: next }, () => this.core.journal.setSetting('agents:limits', next));
    this.changed();
    return next;
  }

  private save<K extends AgentEntityKind>(kind: K, params: AgentSave<AgentEntities[K]>, value: AgentDraft<AgentEntities[K]>): AgentEntities[K] {
    const saved = params.id === undefined ? this.records.create(kind, value) : this.records.update(kind, text(params.id, 'id', 160), integer(params.expectedRevision, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER), value);
    this.changed();
    return saved;
  }

  saveProfile(params: AgentSave<AgentProfile>): AgentProfile {
    const v = params.value;
    object(v, 'profile'); object(v.selection, 'selection');
    const provider = this.core.providers.require(text(v.selection.providerId, 'selection.providerId', 100));
    const account = this.core.accounts.require(text(v.selection.accountId, 'selection.accountId', 160));
    if (account.providerId !== provider.id) throw refused('selection.accountId: account belongs to another provider');
    const model = checkModel(provider, account.id, v.selection.model ?? provider.models.find(m => m.default)?.id ?? provider.models[0]?.id ?? null);
    if (!model) throw refused('selection.model: choose a default model');
    const previous = params.id ? this.records.get('profile', params.id) : null;
    if (previous && this.core.journal.getSetting(`agents:runtime:${previous.id}`) && JSON.stringify(previous.selection) !== JSON.stringify({ ...v.selection, model }) && !this.resident.allowed(previous.id, { ...v.selection, model })) throw refused('selection.model: default model must be allowed by this agent policy');
    const effort = checkEffort(provider, account.id, model, v.selection.effort);
    const accountIntegration = oneOf(v.accountIntegration, 'accountIntegration', ['provider', 'kebacc-experiment']);
    if (accountIntegration === 'kebacc-experiment' && (provider.protocol !== 'agy' || !this.limits().kebaccExperiment)) throw refused('accountIntegration: enable the kebacc experiment for an Antigravity CLI agent first');
    const tools = ids(v.tools, 'tools', TOOLS.length);
    for (const tool of tools) oneOf(tool, 'tools', TOOLS);
    const saved = this.save('profile', params, {
      name: text(v.name, 'name', 100), domain: text(v.domain, 'domain', 500, true), instructions: text(v.instructions, 'instructions', 32000, true),
      avatar: text(v.avatar, 'avatar', 40, true), status: oneOf(v.status, 'status', ['active', 'paused', 'archived']), tools, accountIntegration,
      selection: { providerId: provider.id, accountId: account.id, model, effort, permissionMode: oneOf(v.selection.permissionMode, 'permissionMode', ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']) },
    });
    if (previous && saved.status !== 'active') this.resident.enforce();
    return saved;
  }

  private members(value: unknown, field = 'memberIds'): string[] {
    const members = ids(value, field);
    for (const id of members) this.records.get('profile', id);
    return members;
  }
  saveGroup(params: AgentSave<AgentGroup>): AgentGroup {
    const v = params.value; object(v, 'group');
    return this.save('group', params, { name: text(v.name, 'name', 100), memberIds: this.members(v.memberIds), mode: oneOf(v.mode, 'mode', ['mentions', 'round', 'autonomous']), maxTurns: integer(v.maxTurns, 'maxTurns', 1, 100), maxTurnsPerAgent: integer(v.maxTurnsPerAgent, 'maxTurnsPerAgent', 1, 20), paused: boolean(v.paused, 'paused') });
  }
  saveTeam(params: AgentSave<AgentTeam>): AgentTeam {
    const v = params.value; object(v, 'team');
    if (!Array.isArray(v.members) || v.members.length > 100) throw refused('members: expected at most 100 members');
    const members = v.members.map(m => { object(m, 'member'); return { agentId: text(m.agentId, 'member.agentId', 160), responsibility: text(m.responsibility, 'member.responsibility', 2000, true) }; });
    this.members(members.map(m => m.agentId));
    const projectIds = ids(v.projectIds, 'projectIds');
    for (const id of projectIds) this.core.projects.require(id);
    const groupId = v.groupId === null ? null : text(v.groupId, 'groupId', 160);
    if (groupId) this.records.get('group', groupId);
    return this.save('team', params, { name: text(v.name, 'name', 100), description: text(v.description, 'description', 8000, true), members, projectIds, groupId, paused: boolean(v.paused, 'paused') });
  }
  saveMission(params: AgentSave<AgentMission>): AgentMission {
    const v = params.value; object(v, 'mission');
    const teamId = v.teamId === null ? null : text(v.teamId, 'teamId', 160);
    const team = teamId ? this.records.get('team', teamId) : null;
    const projectId = v.projectId === null ? null : text(v.projectId, 'projectId', 160);
    if (projectId) this.core.projects.require(projectId);
    const agentIds = this.members(v.agentIds, 'agentIds');
    if (team && agentIds.some(id => !team.members.some(m => m.agentId === id))) throw refused('agentIds: every agent must belong to the mission team');
    const resourceIds = ids(v.resourceIds, 'resourceIds');
    for (const id of resourceIds) {
      const s = this.records.get('resource', id).scope;
      if (!(s.kind === 'mission' && s.id === params.id) && !(s.kind === 'team' && s.id === teamId) && !(s.kind === 'project' && s.id === projectId)) throw refused('resourceIds: expected resources belonging to this mission, its team or its project');
    }
    if (params.id) {
      const previous = this.records.get('mission', params.id);
      if (previous.projectId !== projectId && this.records.list('work').some(w => w.scope.kind === 'mission' && w.scope.id === previous.id)) throw refused('projectId: a mission with assigned work keeps its original project; create a new mission for another project');
      if (v.status === 'done' && (this.records.list('task').some(t => t.missionId === previous.id && !['done', 'cancelled'].includes(t.status)) || this.records.list('work').some(w => w.scope.kind === 'mission' && w.scope.id === previous.id && !['done', 'cancelled'].includes(w.status)))) throw refused('mission: complete or cancel its tasks and executions before finishing it');
    }
    const saved = this.save('mission', params, {
      title: text(v.title, 'title', 200), objective: text(v.objective, 'objective', 32000), expectedResult: text(v.expectedResult, 'expectedResult', 8000, true), teamId, projectId, agentIds,
      status: oneOf(v.status, 'status', ['open', 'active', 'waiting', 'paused', 'review', 'done', 'cancelled']), maxTurns: integer(v.maxTurns, 'maxTurns', 1, 1000), maxDurationMs: integer(v.maxDurationMs, 'maxDurationMs', 1000, 86_400_000),
      maxTokens: v.maxTokens === null ? null : integer(v.maxTokens, 'maxTokens', 1, 100_000_000), resourceIds,
    });
    if (saved.status === 'cancelled') {
      for (const work of this.records.list('work').filter(w => w.scope.kind === 'mission' && w.scope.id === saved.id && !['done', 'cancelled'].includes(w.status))) this.control({ workId: work.id, expectedRevision: work.revision, action: 'cancel' });
    }
    return saved;
  }
  saveTask(params: AgentSave<AgentMissionTask>): AgentMissionTask {
    const v = params.value; object(v, 'task');
    const missionId = text(v.missionId, 'missionId', 160); this.records.get('mission', missionId);
    const previous = params.id ? this.records.get('task', params.id) : null;
    if (previous && this.records.list('run').some(run => ['accepted', 'running'].includes(run.status) && this.records.get('work', run.workId).taskId === previous.id)) throw refused('task: wait for its execution to finish before reviewing or editing it');
    if (previous && previous.status !== 'open' && previous.status !== 'review') throw refused('task: only open or submitted tasks can be edited');
    if (previous && previous.missionId !== missionId) throw refused('missionId: a task cannot move between missions');
    const dependsOn = ids(v.dependsOn, 'dependsOn');
    for (const id of dependsOn) {
      if (id === params.id || this.records.get('task', id).missionId !== missionId) throw refused('dependsOn: expected another task in this mission');
      const walk = (taskId: string, visited = new Set<string>()): void => {
        if (taskId === params.id) throw refused('dependsOn: a dependency cycle is not allowed');
        if (visited.has(taskId)) return; visited.add(taskId);
        for (const dependency of this.records.get('task', taskId).dependsOn) walk(dependency, visited);
      };
      walk(id);
    }
    const status = oneOf(v.status, 'task.status', previous?.status === 'review' ? ['review', 'done', 'open', 'cancelled'] : ['open', 'cancelled']);
    return this.save('task', params, { missionId, title: text(v.title, 'title', 200), instructions: text(v.instructions, 'instructions', 32000, true), dependsOn, status,
      assigneeId: status === 'open' ? null : previous?.assigneeId ?? null, generation: previous?.generation ?? 0, leaseUntil: null, workspace: previous?.workspace ?? null, result: previous?.result ?? null });
  }

  session(threadId: string): AgentSession {
    const session = this.records.list('session').find(s => s.threadId === threadId);
    if (!session || this.core.threads.require(threadId).archived) throw refused('threadId: expected an active persistent agent session');
    if (this.records.get('profile', session.agentId).status === 'archived' || !this.canRead(session.agentId, session.scope)) throw refused('scope: this agent no longer belongs to this context');
    return session;
  }
  canRead(agentId: string, target: AgentScope, context?: AgentScope): boolean {
    if (target.kind === 'agent') return target.id === agentId;
    if (context && !sameScope(target, context)) {
      if (context.kind !== 'mission') return false;
      const mission = this.records.get('mission', context.id);
      if (!(target.kind === 'team' && target.id === mission.teamId) && !(target.kind === 'project' && target.id === mission.projectId)) return false;
    }
    if (target.kind === 'group') return this.records.get('group', target.id).memberIds.includes(agentId);
    if (target.kind === 'team') return this.records.get('team', target.id).members.some(m => m.agentId === agentId);
    if (target.kind === 'mission') {
      const mission = this.records.get('mission', target.id);
      return mission.agentIds.includes(agentId) && (!mission.teamId || this.records.get('team', mission.teamId).members.some(m => m.agentId === agentId));
    }
    return this.records.list('mission').some(m => m.projectId === target.id && m.agentIds.includes(agentId));
  }
  requireScope(value: AgentScope): AgentScope {
    const target = scope(value);
    if (target.kind === 'project') this.core.projects.require(target.id);
    else this.records.get(target.kind === 'agent' ? 'profile' : target.kind, target.id);
    return target;
  }
  assertScope(session: AgentSession, target: AgentScope, tool: typeof TOOLS[number]): void {
    if (this.resident.isCompacting(session.threadId)) throw refused('compaction only produces a continuation note; collaboration writes are disabled');
    const agent = this.records.get('profile', session.agentId);
    if (agent.status !== 'active' || !agent.tools.includes(tool)) throw refused(`agent ${agent.id}: ${tool} is not enabled`);
    if (!sameScope(session.scope, target) || !this.canRead(agent.id, target)) throw refused('scope: this execution cannot access another conversation or mission');
  }
  saveMemory(params: AgentSave<AgentMemory> & { threadId?: string }): AgentMemory {
    const v = params.value; object(v, 'memory');
    const target = this.requireScope(v.scope);
    if (!Array.isArray(v.sourceScopes) || v.sourceScopes.length > 100) throw refused('sourceScopes: expected at most 100 scopes');
    const sourceScopes = v.sourceScopes.map(s => this.requireScope(s));
    if (params.threadId) {
      const session = this.session(params.threadId);
      this.assertScope(session, target, 'memory');
      const previous = params.id ? this.records.get('memory', params.id) : null;
      if (previous && !sameScope(previous.scope, target)) throw refused('scope: moving memory requires the owner');
      if (sourceScopes.some(s => !sameScope(s, session.scope))) throw refused('sourceScopes: an agent cannot import another context');
      if (!sourceScopes.some(s => sameScope(s, session.scope))) sourceScopes.push(session.scope);
      if (previous && previous.sourceScopes.some(s => !sourceScopes.some(next => sameScope(s, next)))) throw refused('sourceScopes: an agent cannot remove provenance');
    }
    return this.save('memory', params, { scope: target, title: text(v.title, 'title', 200), text: text(v.text, 'text', 32000), sourceScopes,
      sourceRunId: params.threadId ? this.currentWork(params.threadId).runId : v.sourceRunId === null ? null : text(v.sourceRunId, 'sourceRunId', 160),
      expiresAt: v.expiresAt === null ? null : integer(v.expiresAt, 'expiresAt', 0, Number.MAX_SAFE_INTEGER) });
  }
  saveResource(params: AgentSave<AgentResource>): AgentResource {
    const v = params.value; object(v, 'resource');
    const kind = oneOf(v.kind, 'kind', ['directory', 'url', 'instructions']);
    let value = text(v.value, 'value', 8000);
    if (kind === 'directory') {
      if (!isAbsolute(value)) throw refused('value: expected an absolute directory path');
      try {
        value = realpathSync(value);
        if (!statSync(value).isDirectory()) throw new Error('not a directory');
      } catch { throw refused('value: expected an existing directory'); }
    }
    if (kind === 'url') { let url: URL; try { url = new URL(value); } catch { throw refused('value: expected an HTTP or HTTPS URL'); } if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw refused('value: expected HTTP or HTTPS without credentials'); }
    return this.save('resource', params, { scope: this.requireScope(v.scope), name: text(v.name, 'name', 200), kind, value, access: oneOf(v.access, 'access', ['read', 'write']) });
  }
  currentWork(threadId: string): AgentWork {
    const session = this.session(threadId);
    const run = this.records.list('run').find(r => r.threadId === threadId && r.status === 'running');
    if (!run) throw refused('threadId: this agent has no running collaboration execution');
    const work = this.records.get('work', run.workId);
    if (work.agentId !== session.agentId || work.runId !== run.id || work.status !== 'running') throw refused('execution is no longer current');
    return work;
  }

  resourcesFor(work: AgentWork): AgentResource[] {
    const mission = work.scope.kind === 'mission' ? this.records.get('mission', work.scope.id) : null;
    return this.records.list('resource').filter(resource => this.canRead(work.agentId, resource.scope, work.scope)
      && (resource.scope.kind === 'agent' || sameScope(resource.scope, work.scope) || mission?.resourceIds.includes(resource.id)));
  }

  enqueue(input: Pick<AgentWork, 'agentId' | 'scope' | 'prompt' | 'episodeId'> & Partial<Pick<AgentWork, 'messageId' | 'taskId' | 'taskGeneration'>>): AgentWork {
    return this.records.create('work', { ...input, taskId: input.taskId ?? null, taskGeneration: input.taskGeneration ?? null, messageId: input.messageId ?? null, status: 'pending', error: null, runId: null, notBefore: Date.now() });
  }
  send(params: RpcParams<'agents.message.send'>): AgentEntities['message'] {
    const target = this.requireScope(params.scope);
    if (!['agent', 'group'].includes(target.kind)) throw refused('scope: messages belong to a direct conversation or a group');
    const body = text(params.text, 'text', 32000);
    const session = params.threadId ? this.session(params.threadId) : null;
    if (session) this.assertScope(session, target, 'messages');
    const actor = session?.agentId ?? 'owner';
    const recipientIds = this.members(params.recipientIds, 'recipientIds');
    if (recipientIds.some(id => this.records.get('profile', id).status === 'archived')) throw refused('recipientIds: archived agents cannot receive new work');
    const group = target.kind === 'group' ? this.records.get('group', target.id) : null;
    const allowed = group?.memberIds ?? [target.id];
    if (recipientIds.some(id => !allowed.includes(id))) throw refused('recipientIds: every recipient must belong to this conversation');
    const parent = params.replyTo ? this.records.get('message', params.replyTo) : null;
    if (parent && !sameScope(parent.scope, target)) throw refused('replyTo: message belongs to another conversation');
    const result = this.records.command(actor, params.requestId, { method: 'send', target, body, recipientIds, replyTo: params.replyTo ?? null }, () => {
      const current = session ? this.currentWork(session.threadId) : null;
      const episodeId = current?.episodeId ?? parent?.episodeId ?? newId('episode_');
      const available = allowed.filter(id => this.records.get('profile', id).status !== 'archived');
      const recipients = recipientIds.length ? recipientIds : session || group?.mode === 'mentions' ? [] : group?.mode === 'autonomous' ? available.slice(0, 1) : available;
      const message = this.records.create('message', { scope: target, senderId: session?.agentId ?? null, text: body, recipientIds: recipients, replyTo: parent?.id ?? null, episodeId, sourceRunId: current?.runId ?? null });
      this.deliver(message);
      return message;
    });
    this.changed(); return result;
  }

  /** Called inside the message transaction, including when publishing a provider result. */
  deliver(message: AgentEntities['message']): void {
    const group = message.scope.kind === 'group' ? this.records.get('group', message.scope.id) : null;
    const previous = this.records.list('work').filter(w => w.episodeId === message.episodeId);
    for (const agentId of message.recipientIds) {
      const permitted = previous.length < (group?.maxTurns ?? 20) && previous.filter(w => w.agentId === agentId).length < (group?.maxTurnsPerAgent ?? 20);
      const work = permitted ? this.enqueue({ agentId, scope: message.scope, prompt: message.text, episodeId: message.episodeId, messageId: message.id }) : null;
      if (work) previous.push(work);
      this.records.create('delivery', { messageId: message.id, agentId, status: permitted ? 'pending' : 'limited', workId: work?.id ?? null });
    }
  }

  publishReply(work: AgentWork, runId: string, result: string): void {
    if (!work.messageId || this.records.list('message').some(m => m.sourceRunId === runId)) return;
    const group = work.scope.kind === 'group' ? this.records.get('group', work.scope.id) : null;
    const members = group?.memberIds.filter(id => this.records.get('profile', id).status !== 'archived') ?? [];
    const next = members.length > 1 ? members[(members.indexOf(work.agentId) + 1) % members.length] : undefined;
    const message = this.records.create('message', { scope: work.scope, senderId: work.agentId, text: result || 'Execution completed without a text response.', recipientIds: group?.mode === 'autonomous' && next ? [next] : [], replyTo: work.messageId, episodeId: work.episodeId, sourceRunId: runId });
    this.deliver(message);
  }

  acquire(params: RpcParams<'agents.task.acquire'>): AgentMissionTask {
    const result = this.records.transaction(() => {
      const task = this.records.get('task', params.taskId);
      if (task.revision !== params.expectedRevision || task.status !== 'open') throw refused('task is already assigned or its revision changed');
      const mission = this.records.get('mission', task.missionId);
      if (!['open', 'active'].includes(mission.status)) throw refused('mission is not open for work');
      if (!mission.agentIds.includes(params.agentId)) throw refused('agentId: agent is not assigned to this mission');
      const agent = this.records.get('profile', params.agentId);
      if (agent.status !== 'active') throw refused('agent is not active');
      if (params.threadId) {
        const session = this.session(params.threadId);
        this.assertScope(session, { kind: 'mission', id: mission.id }, 'missions');
        if (session.agentId !== params.agentId) throw refused('agentId: an agent cannot acquire work for another agent');
      }
      if (task.dependsOn.some(id => this.records.get('task', id).status !== 'done')) throw refused('task dependencies are not completed');
      const assigned = this.records.update('task', task.id, task.revision, { ...task, assigneeId: agent.id, status: 'assigned', generation: task.generation + 1, leaseUntil: null });
      this.enqueue({ agentId: agent.id, scope: { kind: 'mission', id: mission.id }, taskId: task.id, taskGeneration: assigned.generation, episodeId: mission.id, prompt: `${mission.objective}\nExpected result: ${mission.expectedResult}\nTask: ${task.title}\n${task.instructions}` });
      return assigned;
    });
    this.changed(); return result;
  }
  submit(params: RpcParams<'agents.task.submit'>): AgentMissionTask {
    const result = this.records.transaction(() => {
      const task = this.records.get('task', params.taskId);
      if (task.generation !== params.generation || !['assigned', 'running'].includes(task.status)) throw refused('task generation is stale or the task no longer accepts results');
      if (params.threadId) {
        const session = this.session(params.threadId);
        this.assertScope(session, { kind: 'mission', id: task.missionId }, 'missions');
        const work = this.currentWork(params.threadId);
        if (task.assigneeId !== session.agentId || work.taskId !== task.id || work.taskGeneration !== task.generation) throw refused('task: this execution does not own the assignment');
      }
      return this.records.update('task', task.id, task.revision, { ...task, status: 'review', result: text(params.result, 'result', 32000), leaseUntil: null });
    });
    this.changed(); return result;
  }

  artifact(params: RpcParams<'agents.artifact.add'>): AgentEntities['artifact'] {
    const session = this.session(params.threadId);
    const v = params.value; object(v, 'artifact');
    const target = this.requireScope({ kind: 'mission', id: v.missionId });
    this.assertScope(session, target, 'artifacts');
    const value = { missionId: target.id, taskId: v.taskId, title: text(v.title, 'title', 200), summary: text(v.summary, 'summary', 32000), paths: ids(v.paths, 'paths', 100), commit: v.commit === null ? null : text(v.commit, 'commit', 64), verification: text(v.verification, 'verification', 8000, true) };
    if (value.commit && !/^[a-f0-9]{7,64}$/.test(value.commit)) throw refused('commit: expected a hexadecimal commit id');
    const result = this.records.command(session.agentId, params.requestId, { method: 'artifact', threadId: params.threadId, value }, () => {
      const work = this.currentWork(params.threadId);
      if (value.taskId !== work.taskId) throw refused('taskId: expected the task of this execution');
      const paths = value.paths.map(path => existingInside(this.core.threads.require(params.threadId).cwd, path, 'file', 'artifact.path').relative);
      return this.records.create('artifact', { ...value, paths, taskId: work.taskId, agentId: session.agentId, runId: work.runId! });
    });
    this.changed(); return result;
  }
  requestDecision(params: RpcParams<'agents.decision.request'>): AgentEntities['decision'] {
    const session = this.session(params.threadId);
    this.assertScope(session, session.scope, 'decisions');
    const prompt = text(params.prompt, 'prompt', 8000);
    const options = ids(params.options, 'options', 10);
    const result = this.records.command(session.agentId, params.requestId, { method: 'decision', scope: session.scope, prompt, options }, () => {
      const work = this.currentWork(params.threadId);
      const decision = this.records.create('decision', { agentId: session.agentId, scope: session.scope, workId: work.id, prompt, options, status: 'pending', answer: null });
      this.records.update('work', work.id, work.revision, { ...work, status: 'waiting' });
      if (work.taskId) {
        const task = this.records.get('task', work.taskId);
        this.records.update('task', task.id, task.revision, { ...task, status: 'waiting', leaseUntil: null });
      }
      return decision;
    });
    this.changed(); return result;
  }
  answerDecision(params: RpcParams<'agents.decision.answer'>): AgentEntities['decision'] {
    const result = this.records.transaction(() => {
      const decision = this.records.get('decision', params.decisionId);
      if (decision.status !== 'pending' || decision.revision !== params.expectedRevision) throw refused('decision is already answered or its revision changed');
      const answer = text(params.answer, 'answer', 8000);
      const work = this.records.get('work', decision.workId);
      if (work.status !== 'waiting') throw refused('decision: the work is no longer waiting');
      const next = this.records.update('decision', decision.id, decision.revision, { ...decision, answer, status: 'answered' });
      this.records.update('work', work.id, work.revision, { ...work, status: 'done' });
      const continuation = this.enqueue({ agentId: work.agentId, scope: work.scope, episodeId: work.episodeId, messageId: work.messageId, taskId: work.taskId, taskGeneration: work.taskGeneration, prompt: `Decision on: ${decision.prompt}\nUser answer: ${answer}\nContinue the work using this decision. Inspect existing effects before taking any action again.` });
      for (const d of this.records.list('delivery').filter(d => d.workId === work.id)) this.records.update('delivery', d.id, d.revision, { ...d, status: 'pending', workId: continuation.id });
      if (work.taskId) {
        const task = this.records.get('task', work.taskId);
        this.records.update('task', task.id, task.revision, { ...task, status: 'assigned' });
      }
      return next;
    });
    this.changed(); return result;
  }
  control(params: RpcParams<'agents.work.control'>): AgentWork {
    const action = oneOf(params.action, 'action', ['pause', 'resume', 'cancel', 'reconcile']);
    let threadId: string | null = null;
    const result = this.records.transaction(() => {
      const work = this.records.get('work', params.workId);
      if (work.revision !== params.expectedRevision) throw refused('work revision changed');
      if (action === 'pause' && work.status === 'waiting') throw refused('work is waiting for a decision; answer or cancel it');
      if (['done', 'cancelled'].includes(work.status)) throw refused('work is already terminal');
      if (action === 'resume' && !['paused', 'error'].includes(work.status)) throw refused('resume: expected paused or failed work; interrupted work requires reconciliation');
      if (action === 'reconcile' && work.status !== 'interrupted') throw refused('reconcile: expected interrupted work');
      const note = action === 'reconcile' ? text(params.note, 'note', 8000) : params.note ? text(params.note, 'note', 8000) : '';
      if (work.runId) threadId = this.records.get('run', work.runId).threadId;
      const status = action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'pending';
      let taskGeneration = work.taskGeneration;
      if (work.taskId) {
        const task = this.records.get('task', work.taskId);
        taskGeneration = task.generation + 1;
        this.records.update('task', task.id, task.revision, { ...task, generation: taskGeneration, leaseUntil: null, status: action === 'cancel' ? 'cancelled' : 'assigned' });
      }
      if (action === 'cancel') for (const decision of this.records.list('decision').filter(d => d.workId === work.id && d.status === 'pending')) this.records.update('decision', decision.id, decision.revision, { ...decision, status: 'cancelled' });
      for (const d of this.records.list('delivery').filter(d => d.workId === work.id)) this.records.update('delivery', d.id, d.revision, { ...d, status: action === 'cancel' ? 'cancelled' : 'pending' });
      const prompt = status === 'pending' ? `${work.prompt}\n\nResuming after an interruption. Inspect previous results and filesystem changes before repeating actions. Continue only unfinished work.\nOwner instructions: ${note || 'Continue from the last known state.'}` : work.prompt;
      return this.records.update('work', work.id, work.revision, { ...work, status, taskGeneration, prompt, error: null, runId: status === 'pending' ? null : work.runId });
    });
    if (threadId && ['pause', 'cancel'].includes(action)) this.core.threads.stopTurn(threadId);
    this.changed(); return result;
  }

  snapshot(threadId?: string): AgentsSnapshot {
    const r = this.records;
    const session = threadId ? this.session(threadId) : null;
    const allowed = (target: AgentScope) => !session || this.canRead(session.agentId, target, session.scope);
    const missions = r.list('mission').filter(m => allowed({ kind: 'mission', id: m.id }));
    const work = r.list('work').filter(w => !session || w.agentId === session.agentId && sameScope(w.scope, session.scope));
    return {
      routines: r.list('routine').filter(v => !session || v.agentId === session.agentId),
      accountGrants: session ? [] : this.resident.grants(),
      revision: r.revision(), limits: this.limits(),
      profiles: r.list('profile').filter(p => !session || p.id === session.agentId || (session.scope.kind === 'group' && this.records.get('group', session.scope.id).memberIds.includes(p.id))).map(p => session && p.id !== session.agentId ? { ...p, instructions: '', selection: { ...p.selection, accountId: '', model: null, effort: null }, tools: [] } : p),
      groups: r.list('group').filter(g => allowed({ kind: 'group', id: g.id })), teams: r.list('team').filter(t => allowed({ kind: 'team', id: t.id })), missions,
      tasks: r.list('task').filter(t => missions.some(m => m.id === t.missionId)),
      sessions: r.list('session').filter(s => !session || s.id === session.id),
      messages: r.list('message').filter(m => !session || sameScope(m.scope, session.scope)),
      deliveries: r.list('delivery').filter(d => !session || work.some(w => w.id === d.workId)), work,
      runs: r.list('run').filter(run => !session || work.some(w => w.id === run.workId)),
      memories: r.list('memory').filter(m => (!session || !m.expiresAt || m.expiresAt > Date.now()) && allowed(m.scope) && m.sourceScopes.every(s => !session || sameScope(s, session.scope))),
      resources: r.list('resource').filter(resource => allowed(resource.scope)),
      artifacts: r.list('artifact').filter(a => missions.some(m => m.id === a.missionId)),
      decisions: r.list('decision').filter(d => !session || work.some(w => w.id === d.workId)),
    };
  }
}

export function registerPersistentAgents(core: Core): void {
  const store = core.workforce;
  core.router.register('agents.runtime.get', p => store.resident.config(p.agentId));
  core.router.register('agents.runtime.configure', p => store.resident.configure(p));
  core.router.register('agents.accounts.set', p => store.resident.setGrants(p.grants));
  core.router.register('agents.brain.get', p => store.resident.brain(p.agentId));
  core.router.register('agents.brain.save', p => store.resident.saveBrain(p));
  core.router.register('agents.routine.save', p => store.routines.save(p));
  core.router.register('agents.routine.run', p => store.routines.run(p));
  core.router.register('agents.context.compact', p => store.resident.compact(p.sessionId, p.requestId));
  core.router.register('agents.snapshot', p => store.snapshot(p.threadId));
  core.router.register('agents.profile.save', p => store.saveProfile(p));
  core.router.register('agents.group.save', p => store.saveGroup(p));
  core.router.register('agents.team.save', p => store.saveTeam(p));
  core.router.register('agents.mission.save', p => store.saveMission(p));
  core.router.register('agents.task.save', p => store.saveTask(p));
  core.router.register('agents.resource.save', p => store.saveResource(p));
  core.router.register('agents.memory.save', p => store.saveMemory(p));
  core.router.register('agents.message.send', p => store.send(p));
  core.router.register('agents.task.acquire', p => store.acquire(p));
  core.router.register('agents.task.submit', p => store.submit(p));
  core.router.register('agents.limits.set', p => store.setLimits(p));
  core.router.register('agents.artifact.add', p => store.artifact(p));
  core.router.register('agents.decision.request', p => store.requestDecision(p));
  core.router.register('agents.decision.answer', p => store.answerDecision(p));
  core.router.register('agents.work.control', p => store.control(p));
}
