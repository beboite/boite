import type { AgentDraft, AgentEntities, AgentEntityKind, AgentRecord, AgentSave, AgentWork, AgentsRpcMethods, AgentsSnapshot, RpcParams, AgentProfile, Turn } from '@boite/contracts';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './client';

/** In-memory projection for interface journeys. Real process and crash behavior is tested against the core. */
export class FakeAgents {
  private closed = false;
  private pumping = false;
  private rows = new Map<string, AgentRecord>();
  private receipts = new Map<string, { fingerprint: string; result: unknown }>();
  private revision = 0;
  private sequence = 0;
  private limits: AgentsSnapshot['limits'] = { backgroundConcurrency: 2, paused: false, kebaccExperiment: false };
  constructor(private readonly changed: (revision: number) => void, private readonly runner?: {
    create: (agent: AgentProfile, sessionId: string, work: AgentWork) => string;
    start: (threadId: string, prompt: string, agent: AgentProfile) => Turn;
    stop: (threadId: string) => void;
  }) {}
  close(): void { this.closed = true; }
  open(): void { this.closed = false; this.kick(); }
  private kick(): void { queueMicrotask(() => { this.pauseRuns(); this.pump(); }); }
  private pauseRuns(): void {
    if (this.closed) return;
    for (const run of this.all('run').filter(r => ['accepted', 'running'].includes(r.status))) {
      const work = this.get('work', run.workId);
      const agent = this.get('profile', work.agentId);
      const group = work.scope.kind === 'group' ? this.get('group', work.scope.id) : null;
      const mission = work.scope.kind === 'mission' ? this.get('mission', work.scope.id) : null;
      if (this.limits.paused || agent.status !== 'active' || group && (group.paused || !group.memberIds.includes(agent.id)) || mission && (!['open', 'active'].includes(mission.status) || mission.teamId && this.get('team', mission.teamId).paused)) {
        this.update('work', { ...work, status: 'paused', error: 'Background work is paused.' });
        this.runner?.stop(run.threadId);
      }
    }
  }
  private pump(): void {
    if (!this.runner || this.closed || this.pumping || this.limits.paused) return;
    this.pumping = true;
    try {
      for (const work of this.all('work').filter(w => w.status === 'pending')) {
        const active = this.all('run').filter(r => ['accepted', 'running'].includes(r.status));
        if (active.length >= this.limits.backgroundConcurrency) break;
        if (active.some(r => r.agentId === work.agentId)) continue;
        const agent = this.get('profile', work.agentId);
        if (agent.status !== 'active') continue;
        if (work.scope.kind === 'group') {
          const group = this.get('group', work.scope.id); if (group.paused || !group.memberIds.includes(agent.id)) continue;
          const used = this.all('run').filter(r => this.get('work', r.workId).episodeId === work.episodeId && r.startedAt !== null);
          if (used.length >= group.maxTurns || used.filter(r => r.agentId === agent.id).length >= group.maxTurnsPerAgent) { this.update('work', { ...work, status: 'paused', error: 'Group turn limit reached.' }); continue; }
        }
        if (work.scope.kind === 'mission') {
          const mission = this.get('mission', work.scope.id);
          if (!['open', 'active'].includes(mission.status) || mission.teamId && this.get('team', mission.teamId).paused) continue;
          if (this.all('run').filter(r => this.get('work', r.workId).scope.id === mission.id).length >= mission.maxTurns) { this.update('work', { ...work, status: 'paused', error: 'Mission turn limit reached.' }); continue; }
        }
        let session = this.all('session').find(s => s.agentId === work.agentId && s.scope.kind === work.scope.kind && s.scope.id === work.scope.id);
        if (!session) {
          session = this.save('session', { value: { agentId: work.agentId, scope: work.scope, threadId: '' } });
          session = this.update('session', { ...session, threadId: this.runner.create(agent, session.id, work) });
        }
        const run = this.save('run', { value: { workId: work.id, agentId: work.agentId, threadId: session.threadId, turnId: null, execution: agent.selection, profileRevision: agent.revision, context: { instructions: work.prompt, memoryIds: [], resources: [], messageIds: work.messageId ? [work.messageId] : [] }, status: 'accepted', startedAt: null, finishedAt: null, actualExecution: null } });
        this.update('work', { ...work, runId: run.id, status: 'running' });
        try {
          const turn = this.runner.start(session.threadId, work.prompt, agent);
          this.update('run', { ...run, status: 'running', turnId: turn.id, actualExecution: turn.execution ?? null, startedAt: Date.now() });
          if (work.taskId) this.update('task', { ...this.get('task', work.taskId), status: 'running', leaseUntil: Date.now() + 30000 });
          for (const d of this.all('delivery').filter(d => d.workId === work.id)) this.update('delivery', { ...d, status: 'included' });
        } catch (error) { this.update('run', { ...run, status: 'error', finishedAt: Date.now() }); this.update('work', { ...this.get('work', work.id), status: 'error', error: String(error) }); }
      }
    } finally { this.pumping = false; }
  }
  finished(turn: Turn, result: string): void {
    const run = this.all('run').find(r => r.threadId === turn.threadId && ['accepted', 'running'].includes(r.status));
    if (!run) return;
    this.update('run', { ...run, status: turn.status === 'done' ? 'done' : 'error', finishedAt: Date.now() });
    const work = this.get('work', run.workId);
    if (work.status === 'running' && work.runId === run.id) {
      this.update('work', { ...work, status: turn.status === 'done' ? 'done' : 'error', error: turn.error });
      if (turn.status === 'done') {
        if (work.taskId) { const task = this.get('task', work.taskId); if (task.generation === work.taskGeneration && task.status === 'running') this.update('task', { ...task, status: 'review', result, leaseUntil: null }); }
        if (work.messageId && !this.all('message').some(m => m.sourceRunId === run.id)) {
          const group = work.scope.kind === 'group' ? this.get('group', work.scope.id) : null;
          const members = group?.memberIds ?? [];
          const next = members.length > 1 ? members[(members.indexOf(work.agentId) + 1) % members.length] : undefined;
          const message = this.save('message', { value: { scope: work.scope, senderId: work.agentId, recipientIds: group?.mode === 'autonomous' && next ? [next] : [], text: result, replyTo: work.messageId, episodeId: work.episodeId, sourceRunId: run.id } });
          this.deliver(message);
        }
      }
      for (const d of this.all('delivery').filter(d => d.workId === work.id)) this.update('delivery', { ...d, status: turn.status === 'done' ? 'processed' : 'failed' });
    }
    this.kick();
  }
  private deliver(message: AgentEntities['message']): void {
    const group = message.scope.kind === 'group' ? this.get('group', message.scope.id) : null;
    for (const agentId of message.recipientIds) {
      const previous = this.all('work').filter(w => w.episodeId === message.episodeId);
      const permitted = previous.length < (group?.maxTurns ?? 20) && previous.filter(w => w.agentId === agentId).length < (group?.maxTurnsPerAgent ?? 20);
      const work = permitted ? this.work({ agentId, scope: message.scope, episodeId: message.episodeId, prompt: message.text, messageId: message.id }) : null;
      this.save('delivery', { value: { messageId: message.id, agentId, status: permitted ? 'pending' : 'limited', workId: work?.id ?? null } });
    }
  }
  private refuse(message: string): never { throw new RpcFailure({ code: RpcErrorCode.Refused, message }); }
  private all<K extends AgentEntityKind>(kind: K): AgentEntities[K][] { return [...this.rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, row]) => structuredClone(row) as AgentEntities[K]); }
  private get<K extends AgentEntityKind>(kind: K, id: string): AgentEntities[K] {
    const value = this.rows.get(`${kind}:${id}`);
    if (!value) this.refuse(`unknown ${kind} ${id}`);
    return structuredClone(value) as AgentEntities[K];
  }
  private save<K extends AgentEntityKind>(kind: K, params: AgentSave<AgentEntities[K]>): AgentEntities[K] {
    const previous = params.id ? this.get(kind, params.id) : null;
    if (previous && previous.revision !== params.expectedRevision) this.refuse(`${kind} revision changed`);
    const record = { ...structuredClone(params.value), id: previous?.id ?? `fake-agent-${++this.sequence}`, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() } as AgentEntities[K];
    this.rows.set(`${kind}:${record.id}`, record);
    this.changed(++this.revision);
    return structuredClone(record);
  }
  private update<K extends AgentEntityKind>(kind: K, value: AgentEntities[K]): AgentEntities[K] { return this.save(kind, { id: value.id, expectedRevision: value.revision, value }); }
  private work(value: Pick<AgentWork, 'agentId' | 'scope' | 'episodeId' | 'prompt'> & Partial<AgentDraft<AgentWork>>): AgentWork {
    return this.save('work', { value: { taskId: null, taskGeneration: null, messageId: null, status: 'pending', error: null, runId: null, notBefore: Date.now(), ...value } });
  }
  private once<T>(requestId: string, value: unknown, run: () => T): T {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) this.refuse('requestId: expected 8 to 128 letters, numbers, underscores or hyphens');
    const fingerprint = JSON.stringify(value);
    const previous = this.receipts.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) this.refuse('requestId already used with different input');
      return structuredClone(previous.result) as T;
    }
    const result = run(); this.receipts.set(requestId, { fingerprint, result: structuredClone(result) }); return result;
  }
  snapshot(): AgentsSnapshot {
    return { revision: this.revision, limits: { ...this.limits }, profiles: this.all('profile'), groups: this.all('group'), teams: this.all('team'), missions: this.all('mission'), tasks: this.all('task'), sessions: this.all('session'), messages: this.all('message'), deliveries: this.all('delivery'), work: this.all('work'), runs: this.all('run'), memories: this.all('memory'), resources: this.all('resource'), artifacts: this.all('artifact'), decisions: this.all('decision') };
  }
  call(method: keyof AgentsRpcMethods, raw: unknown): unknown {
    try { return this.dispatch(method, raw); } finally { if (method !== 'agents.snapshot') this.kick(); }
  }
  private dispatch(method: keyof AgentsRpcMethods, raw: unknown): unknown {
    switch (method) {
      case 'agents.snapshot': return this.snapshot();
      case 'agents.profile.save': {
        const p = raw as RpcParams<typeof method>;
        if (!p.value.name.trim()) this.refuse('name: expected nonempty text');
        if (p.value.accountIntegration === 'kebacc-experiment' && (!this.limits.kebaccExperiment || p.value.selection.providerId !== 'antigravity-cli')) this.refuse('enable the kebacc experiment for an Antigravity CLI agent first');
        return this.save('profile', p);
      }
      case 'agents.group.save': {
        const p = raw as RpcParams<typeof method>;
        if (!p.value.name.trim() || !Number.isInteger(p.value.maxTurns) || p.value.maxTurns < 1 || p.value.maxTurns > 100 || p.value.maxTurnsPerAgent < 1 || p.value.maxTurnsPerAgent > 20) this.refuse('group: invalid name or turn limit');
        for (const id of p.value.memberIds) this.get('profile', id);
        return this.save('group', p);
      }
      case 'agents.team.save': {
        const p = raw as RpcParams<typeof method>;
        for (const m of p.value.members) this.get('profile', m.agentId);
        if (p.value.groupId) this.get('group', p.value.groupId);
        return this.save('team', p);
      }
      case 'agents.mission.save': {
        const p = raw as RpcParams<typeof method>;
        for (const id of p.value.agentIds) this.get('profile', id);
        if (p.value.teamId) {
          const team = this.get('team', p.value.teamId);
          if (p.value.agentIds.some(id => !team.members.some(m => m.agentId === id))) this.refuse('agentIds: every agent must belong to the mission team');
        }
        if (p.id && p.value.status === 'done' && (this.all('task').some(t => t.missionId === p.id && !['done', 'cancelled'].includes(t.status)) || this.all('work').some(w => w.scope.kind === 'mission' && w.scope.id === p.id && !['done', 'cancelled'].includes(w.status)))) this.refuse('mission: complete or cancel its tasks and executions before finishing it');
        const saved = this.save('mission', p);
        if (saved.status === 'cancelled') for (const work of this.all('work').filter(w => w.scope.kind === 'mission' && w.scope.id === saved.id && !['done', 'cancelled'].includes(w.status))) this.dispatch('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'cancel' });
        return saved;
      }
      case 'agents.task.save': {
        const p = raw as RpcParams<typeof method>;
        this.get('mission', p.value.missionId);
        const previous = p.id ? this.get('task', p.id) : null;
        if (previous && this.all('run').some(r => ['accepted', 'running'].includes(r.status) && this.get('work', r.workId).taskId === previous.id)) this.refuse('task: wait for its execution to finish');
        if (previous && !['open', 'review'].includes(previous.status)) this.refuse('only open or submitted tasks can be edited');
        for (const id of p.value.dependsOn) if (id === p.id || this.get('task', id).missionId !== p.value.missionId) this.refuse('dependsOn: expected another task in this mission');
        return this.save('task', { ...p, value: { ...p.value, assigneeId: p.value.status === 'open' ? null : previous?.assigneeId ?? null, generation: previous?.generation ?? 0, workspace: previous?.workspace ?? null, result: previous?.result ?? null, leaseUntil: null } });
      }
      case 'agents.resource.save': return this.save('resource', raw as RpcParams<typeof method>);
      case 'agents.memory.save': return this.save('memory', raw as RpcParams<typeof method>);
      case 'agents.limits.set': {
        const p = raw as RpcParams<typeof method>;
        if (!Number.isInteger(p.backgroundConcurrency) || p.backgroundConcurrency < 1 || p.backgroundConcurrency > 8) this.refuse('backgroundConcurrency: expected an integer from 1 to 8');
        this.limits = { ...p }; this.changed(++this.revision); return this.limits;
      }
      case 'agents.message.send': {
        const p = raw as RpcParams<typeof method>;
        if (!p.text.trim() || p.text.length > 32000) this.refuse('text: expected 1 to 32000 characters');
        const group = p.scope.kind === 'group' ? this.get('group', p.scope.id) : null;
        if (!group && p.scope.kind !== 'agent') this.refuse('scope: messages belong to a direct conversation or a group');
        const allowed = group?.memberIds ?? [this.get('profile', p.scope.id).id];
        if (p.recipientIds.some(id => !allowed.includes(id))) this.refuse('recipientIds: every recipient must belong to this conversation');
        const parent = p.replyTo ? this.get('message', p.replyTo) : null;
        if (parent && (parent.scope.id !== p.scope.id || parent.scope.kind !== p.scope.kind)) this.refuse('replyTo: message belongs to another conversation');
        return this.once(p.requestId, { method, ...p }, () => {
          const recipientIds = p.recipientIds.length ? p.recipientIds : group?.mode === 'mentions' ? [] : group?.mode === 'autonomous' ? allowed.slice(0, 1) : allowed;
          const episodeId = parent?.episodeId ?? `fake-episode-${++this.sequence}`;
          const message = this.save('message', { value: { scope: p.scope, senderId: null, text: p.text, recipientIds, replyTo: p.replyTo ?? null, episodeId, sourceRunId: null } });
          this.deliver(message);
          return message;
        });
      }
      case 'agents.task.acquire': {
        const p = raw as RpcParams<typeof method>;
        const task = this.get('task', p.taskId); const mission = this.get('mission', task.missionId);
        if (task.revision !== p.expectedRevision || task.status !== 'open') this.refuse('task is already assigned or its revision changed');
        if (!['open', 'active'].includes(mission.status)) this.refuse('mission is not open for work');
        if (!mission.agentIds.includes(p.agentId)) this.refuse('agent is not assigned to this mission');
        if (task.dependsOn.some(id => this.get('task', id).status !== 'done')) this.refuse('task dependencies are not completed');
        const next = this.update('task', { ...task, assigneeId: p.agentId, status: 'assigned', generation: task.generation + 1 });
        this.work({ agentId: p.agentId, scope: { kind: 'mission', id: mission.id }, episodeId: mission.id, prompt: `${mission.objective}\n${task.instructions}`, taskId: task.id, taskGeneration: next.generation });
        return next;
      }
      case 'agents.task.submit': {
        const p = raw as RpcParams<typeof method>; const task = this.get('task', p.taskId);
        if (task.generation !== p.generation || !['assigned', 'running'].includes(task.status)) this.refuse('task generation is stale');
        return this.update('task', { ...task, status: 'review', result: p.result, leaseUntil: null });
      }
      case 'agents.work.control': {
        const p = raw as RpcParams<typeof method>; const work = this.get('work', p.workId);
        if (work.revision !== p.expectedRevision || ['done', 'cancelled'].includes(work.status)) this.refuse('work is terminal or its revision changed');
        if (p.action === 'resume' && !['paused', 'error'].includes(work.status)) this.refuse('interrupted work requires reconciliation');
        if (p.action === 'reconcile' && (work.status !== 'interrupted' || !p.note?.trim())) this.refuse('reconcile: expected interrupted work and an inspection note');
        if (p.action === 'pause' && work.status === 'waiting') this.refuse('work is waiting for a decision; answer or cancel it');
        let taskGeneration = work.taskGeneration;
        if (work.taskId) { const task = this.get('task', work.taskId); taskGeneration = task.generation + 1; this.update('task', { ...task, generation: taskGeneration, leaseUntil: null, status: p.action === 'cancel' ? 'cancelled' : 'assigned' }); }
        if (p.action === 'cancel') for (const d of this.all('decision').filter(d => d.workId === work.id && d.status === 'pending')) this.update('decision', { ...d, status: 'cancelled' });
        for (const d of this.all('delivery').filter(d => d.workId === work.id)) this.update('delivery', { ...d, status: p.action === 'cancel' ? 'cancelled' : 'pending' });
        const updated = this.update('work', { ...work, taskGeneration, status: p.action === 'pause' ? 'paused' : p.action === 'cancel' ? 'cancelled' : 'pending', runId: ['resume', 'reconcile'].includes(p.action) ? null : work.runId, error: null });
        if (work.runId && ['pause', 'cancel'].includes(p.action)) this.runner?.stop(this.get('run', work.runId).threadId);
        return updated;
      }
      case 'agents.decision.answer': {
        const p = raw as RpcParams<typeof method>; const d = this.get('decision', p.decisionId);
        if (d.status !== 'pending' || d.revision !== p.expectedRevision) this.refuse('decision is already answered or its revision changed');
        const work = this.get('work', d.workId);
        if (work.status !== 'waiting' || !p.answer.trim()) this.refuse('decision: expected waiting work and an answer');
        this.update('work', { ...work, status: 'done' });
        const continuation = this.work({ agentId: d.agentId, scope: d.scope, episodeId: work.episodeId, messageId: work.messageId, prompt: p.answer, taskId: work.taskId, taskGeneration: work.taskGeneration });
        if (work.taskId) this.update('task', { ...this.get('task', work.taskId), status: 'assigned' });
        for (const delivery of this.all('delivery').filter(item => item.workId === work.id)) this.update('delivery', { ...delivery, status: 'pending', workId: continuation.id });
        return this.update('decision', { ...d, status: 'answered', answer: p.answer });
      }
      case 'agents.decision.request': {
        const p = raw as RpcParams<typeof method>;
        const run = this.all('run').find(r => r.threadId === p.threadId && r.status === 'running');
        if (!run) this.refuse('threadId: this agent has no running collaboration execution');
        const work = this.get('work', run.workId);
        return this.once(p.requestId, { method, ...p }, () => {
          this.update('work', { ...work, status: 'waiting' });
          if (work.taskId) this.update('task', { ...this.get('task', work.taskId), status: 'waiting', leaseUntil: null });
          const decision = this.save('decision', { value: { scope: work.scope, workId: work.id, agentId: work.agentId, prompt: p.prompt, options: p.options, status: 'pending', answer: null } });
          this.runner?.stop(run.threadId);
          return decision;
        });
      }
      case 'agents.artifact.add': {
        const p = raw as RpcParams<typeof method>; const run = this.all('run').find(r => r.threadId === p.threadId && r.status === 'running');
        if (!run) this.refuse('threadId: this agent has no running collaboration execution');
        return this.once(p.requestId, { method, ...p }, () => this.save('artifact', { value: { ...p.value, agentId: run.agentId, runId: run.id } }));
      }
    }
  }
}
