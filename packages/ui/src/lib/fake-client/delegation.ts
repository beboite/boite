/** Delegation: a parent thread's team of child threads, their usage and letters. */
import { collectNativeAgents, collectProcessAgents, CONVERSATION_PROFILE_ID, DEFAULT_DELEGATION_CONFIG, matchSpeed, RpcErrorCode, speedRefusal, type AgentLetter, type DelegatedAgent, type DelegationConfig, type DelegationModelChoice, type DelegationProfile, type DelegationView, type DelegationWaitResult, type RpcParams, type Message, type Thread, type ThreadId, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { addUsage, emptyUsage, toSummary } from './shared';
import { modelsOf } from './provider-catalog';
import type { FakeContext, FakeMethods } from './context';

function delegationRoot(ctx: FakeContext, threadId: ThreadId): ThreadId {
  const thread = ctx.thread(threadId);
  return thread.parentThreadId ?? thread.id;
}

export function delegationConfig(ctx: FakeContext, rootId: ThreadId): DelegationConfig {
  const saved = ctx.delegationConfigs.get(rootId) ?? DEFAULT_DELEGATION_CONFIG;
  return structuredClone({ enabled: saved.enabled, paused: saved.paused, profiles: saved.profiles, anyModel: saved.anyModel !== false });
}

/** What the real core's catalog reads: every available provider's models on its first account, the parent's own first. */
function modelChoices(ctx: FakeContext, parent: Thread): DelegationModelChoice[] {
  return ctx.providers.filter(provider => provider.available && provider.enabled !== false).flatMap(provider => {
    const account = ctx.accounts.find(entry => entry.id === parent.accountId && entry.providerId === provider.id) ?? ctx.accounts.find(entry => entry.providerId === provider.id);
    if (!account) return [];
    return modelsOf(ctx, provider.id, account.id).filter(model => !model.legacy).map(model => ({
      providerId: provider.id, providerName: provider.name, accountId: account.id, model: model.id, name: model.name,
      efforts: model.effort?.levels.map(level => level.id) ?? [], defaultEffort: model.effort?.default ?? null,
      speeds: model.speeds?.map(speed => ({ id: speed.id, label: speed.label })) ?? [],
      current: parent.providerId === provider.id && parent.model === model.id,
    }));
  });
}

/** The core's speed resolution: by id or label, any case, refused naming the model and what it offers. */
function pickSpeed(ctx: FakeContext, route: ChildRoute, wanted: string | undefined): string | null {
  if (wanted === undefined) return null;
  if (route.model === null) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'speed: this route runs on the provider\'s default model; name a model with --model to choose its speed' });
  const speeds = modelsOf(ctx, route.providerId, route.accountId).find(model => model.id === route.model)?.speeds ?? [];
  const speed = matchSpeed(speeds, wanted);
  if (speed === null) throw new RpcFailure({ code: RpcErrorCode.Refused, message: speedRefusal(`${route.providerId}/${route.model}`, speeds, wanted) });
  return speed;
}

/** `provider/model`, a model id (the parent's provider first) or a unique part of an id or name. */
function pickModel(ctx: FakeContext, parent: Thread, config: DelegationConfig, wanted: string, effort: string | undefined): ChildRoute {
  const choices = modelChoices(ctx, parent), query = wanted.toLowerCase();
  const full = (c: DelegationModelChoice) => `${c.providerId}/${c.model}`;
  const byId = choices.filter(c => full(c) === query || c.model.toLowerCase() === query);
  const found = byId.length ? byId : choices.filter(c => full(c).toLowerCase().includes(query) || c.name.toLowerCase().includes(query));
  const choice = found.find(c => c.providerId === parent.providerId) && found.length > 1 && byId.length ? found.find(c => c.providerId === parent.providerId)! : found.length === 1 ? found[0]! : undefined;
  if (!choice) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `model: ${found.length ? `"${wanted}" matches ${found.map(full).join(', ')}` : `no installed model matches "${wanted}"`}` });
  if (config.anyModel === false && !(choice.providerId === parent.providerId && choice.model === parent.model) && !config.profiles.some(p => p.providerId === choice.providerId && p.model === choice.model)) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the owner limited subagents to this conversation\'s model and the profiles' });
  }
  if (effort !== undefined && !choice.efforts.includes(effort)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model does not offer this reasoning effort' });
  return { id: full(choice), name: choice.name, providerId: choice.providerId, accountId: choice.accountId, model: choice.model, effort: effort ?? choice.defaultEffort };
}

function delegatedAgent(ctx: FakeContext, row: { threadId: ThreadId; profileId: string; task: string }): DelegatedAgent {
  const thread = ctx.thread(row.threadId);
  const lastTurn = thread.turns.at(-1) ?? null;
  const result = lastTurn && !['queued', 'running'].includes(lastTurn.status)
    ? thread.messages.filter(message => message.turnId === lastTurn.id && message.role === 'assistant').at(-1)?.parts
        .filter(part => part.type === 'text').map(part => part.text).join('\n').trim().slice(0, 4000) || lastTurn.error
    : null;
  return { thread: structuredClone(toSummary(thread)), profileId: row.profileId, task: row.task, lastTurn: structuredClone(lastTurn), result: result || null, ...(lastTurn && !['queued', 'running'].includes(lastTurn.status) ? { resultRef: { agentId: thread.id, turnId: lastTurn.id }, settlement: 'result_available' as const } : lastTurn === null ? { settlement: 'settled' as const } : {}) };
}

function delegationView(ctx: FakeContext, rootId: ThreadId, callerId = rootId): DelegationView {
  ctx.thread(rootId);
  const rows = ctx.delegationAgents.get(rootId) ?? [];
  let usage = emptyUsage();
  for (const row of rows) for (const turn of ctx.thread(row.threadId).turns) if (turn.usage) usage = addUsage(usage, turn.usage);
  return {
    rootThreadId: rootId,
    settlement: rows.some(row => { const turn = ctx.thread(row.threadId).turns.at(-1); return turn && ['queued', 'running'].includes(turn.status); }) ? 'waiting_for_children' : 'settled',
    config: delegationConfig(ctx, rootId),
    agents: rows.map(row => delegatedAgent(ctx, row)),
    nativeAgents: [...collectNativeAgents(ctx.thread(callerId).messages.flatMap(message => message.role === 'assistant' ? message.parts.map(part => ({ part, at: message.createdAt, turnId: message.turnId, turnStatus: ctx.thread(callerId).turns.find(turn => turn.id === message.turnId)?.status })) : []), ctx.thread(callerId).background), ...collectProcessAgents(ctx.processes.filter(record => record.threadId === callerId), ctx.processes.filter(record => record.threadId === callerId && record.exitedAt === null))],
    messages: structuredClone((ctx.delegationLetters.get(rootId) ?? []).filter(letter => callerId === rootId || letter.from.threadId === callerId || letter.to.threadId === callerId)),
    turnsUsed: ctx.delegationTurns.get(rootId) ?? 0,
    usage
  };
}

export async function stopDelegation(ctx: FakeContext, rootId: ThreadId, agentId?: ThreadId): Promise<number> {
  const rows = ctx.delegationAgents.get(rootId) ?? [];
  const selected = agentId ? rows.filter(row => row.threadId === agentId) : rows;
  if (agentId && selected.length === 0) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'agentId must name a direct child' });
  // Nothing unfinished, nothing to stop: the team stays usable. Finished children are history.
  if (!agentId && rows.some(row => ['queued', 'running', 'waiting'].includes(ctx.thread(row.threadId).status))) ctx.delegationConfigs.set(rootId, { ...delegationConfig(ctx, rootId), paused: true });
  let stopped = 0;
  for (const row of selected) {
    const thread = ctx.thread(row.threadId);
    if (['queued', 'running', 'waiting'].includes(thread.status)) stopped += 1;
    const queued = thread.turns.at(-1);
    if (queued?.status === 'queued') {
      queued.status = 'stopped';
      queued.finishedAt = ctx.now();
      ctx.scheduler.queued = ctx.scheduler.queued.filter(entry => entry.turnId !== queued.id);
    }
    await ctx.stopTurn(thread.id);
    thread.status = 'idle';
    ctx.touch(thread);
  }
  return stopped;
}

export function seedDelegationDemo(ctx: FakeContext): void {
  const demoAt = Date.now() - 85_000;
  const root = ctx.thread('t-trace');
  const nativeId = 't-native';
  const nativeTurn: Turn = { id: 'turn-native-demo', threadId: nativeId, status: 'done', queuedAt: demoAt, startedAt: demoAt, finishedAt: demoAt + 10_000, usage: null, error: null };
  const nativeMessage: Message = { id: 'm-native-demo', threadId: nativeId, turnId: nativeTurn.id, role: 'assistant', state: 'complete', createdAt: demoAt, parts: [
    { type: 'tool', toolId: 'native-spawn', name: 'Agent', input: { action: 'spawnAgent' }, output: null, status: 'done', nativeAgents: [{ id: 'native-reviewer', name: 'Review parser boundaries', task: 'Check parsing and invalid inputs.', model: 'fake-smart', status: 'done', result: 'Parser checked' }] },
    { type: 'tool', toolId: 'native-research', name: 'Agent', input: { action: 'spawnAgent' }, output: null, status: 'done', nativeAgents: [{ id: 'native-research', name: 'Research compatibility', status: 'unknown' }] },
  ] };
  ctx.threads.set(nativeId, { ...root, id: nativeId, title: 'Review parser boundaries', providerId: 'codex', accountId: 'a-codex', model: 'gpt-6-astra', status: 'idle', turns: [nativeTurn], messages: [nativeMessage], activity: undefined, background: [], memoryEvents: [], pullRequest: null, load: null, context: null, messagesBefore: null, parentThreadId: null });
  const cliId = 't-cli';
  ctx.threads.set(cliId, { ...ctx.thread(nativeId), id: cliId, title: 'Review the gameplay audit', turns: [], messages: [], background: [] });
  const shell = { threadId: cliId, pid: 6400, parentPid: 1, exe: 'pwsh.exe', commandLine: 'pwsh.exe review.ps1', startedAt: demoAt, exitedAt: demoAt + 2000, exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
  ctx.processes.push(shell, { ...shell, pid: 6401, parentPid: shell.pid, exe: 'claude.exe', commandLine: 'claude.exe --print --model claude-opus-5-5 --effort xhigh "Review the gameplay audit"', startedAt: demoAt + 1000, exitedAt: null, exitCode: null });
  const reviewer: DelegationProfile = { id: 'reviewer', name: 'Reviewer', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-sonnet-5-5', effort: 'high' };
  const implementer: DelegationProfile = { id: 'implementer', name: 'Implementer', providerId: 'codex', accountId: 'a-codex', model: 'gpt-6.1-sol', effort: 'medium' };
  ctx.delegationConfigs.set(root.id, { enabled: true, paused: false, profiles: [reviewer, implementer] });
  const make = (id: string, title: string, task: string, status: Thread['status'], answer: string, profile: DelegationProfile): Thread => {
    const turn: Turn = { id: `turn-${id}`, threadId: id, status: status === 'running' ? 'running' : 'done', queuedAt: demoAt, startedAt: demoAt + 1000, finishedAt: status === 'running' ? null : demoAt + 30_000, usage: status === 'running' ? null : { inputTokens: 820, outputTokens: 260, cacheReadTokens: 1200, cacheWriteTokens: 0, costUsdEquivalent: 0.012 }, error: null };
    return {
      ...root, id, parentThreadId: root.id, title, titleSource: 'user', status, unread: false, archived: false, pinned: false,
      providerId: profile.providerId, accountId: profile.accountId, model: profile.model, effort: profile.effort,
      sessionId: `session-${id}`, sessionGeneration: 0, selectionVersion: 0, load: status === 'running' ? { processes: 1, cpuPercent: 8, memoryBytes: 64 * 1024 * 1024 } : null,
      createdAt: demoAt, updatedAt: demoAt + 30_000, messagesBefore: null, commands: [], turns: [turn],
      messages: [
        { id: `m-${id}-1`, threadId: id, turnId: turn.id, role: 'user', parts: [{ type: 'text', text: task }], state: 'complete', createdAt: demoAt },
        { id: `m-${id}-2`, threadId: id, turnId: turn.id, role: 'assistant', parts: [{ type: 'text', text: answer }], state: status === 'running' ? 'streaming' : 'complete', createdAt: demoAt + 10_000 }
      ]
    };
  };
  const running = make('t-team-running', 'Audit subscription flow', 'Check selection races and own the store tests.', 'running', 'I found the subscription boundary and am checking stale responses.', reviewer);
  const done = make('t-team-done', 'Review panel copy', 'Review the panel wording and report confusing states.', 'idle', 'The queued delivery label now matches the core state.', implementer);
  ctx.threads.set(running.id, running);
  ctx.threads.set(done.id, done);
  ctx.delegationAgents.set(root.id, [
    { threadId: running.id, profileId: reviewer.id, task: 'Check selection races and own the store tests.' },
    { threadId: done.id, profileId: implementer.id, task: 'Review the panel wording and report confusing states.' }
  ]);
  ctx.delegationTurns.set(root.id, 2);
  seedWorkflowDemo(ctx, root.id);
}

/** A workflow step's thread, the way `delegation.spawn` makes one: the task sent, the turn running. */
/** A profile, or the conversation's own route, whose model may be the provider's default. */
export type ChildRoute = Omit<DelegationProfile, 'model'> & { model: string | null };

export function workflowChild(ctx: FakeContext, root: Thread, profile: ChildRoute, title: string, task: string): ThreadId {
  const id = `t-${++ctx.seq}`;
  const at = ctx.now();
  const turn: Turn = { id: `turn-${id}`, threadId: id, status: 'running', queuedAt: at, startedAt: at, finishedAt: null, usage: null, error: null };
  const child: Thread = {
    ...root, id, parentThreadId: root.id, title, titleSource: 'user',
    providerId: profile.providerId, accountId: profile.accountId, model: profile.model, effort: profile.effort, speed: null,
    status: 'running', unread: false, archived: false, pinned: false,
    sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, activity: undefined, moveNote: null,
    createdAt: at, updatedAt: at, messagesBefore: null, turns: [turn], commands: [],
    messages: [{ id: `m-${id}-task`, threadId: id, turnId: turn.id, role: 'user', parts: [{ type: 'text', text: task }], state: 'complete', createdAt: at }]
  };
  delete child.pullRequest;
  delete child.lastUserMessageAt;
  ctx.threads.set(id, child);
  ctx.emit('thread.created', structuredClone(toSummary(child)));
  return id;
}

/** The step's answer, and its thread idle again. */
export function workflowAnswer(ctx: FakeContext, threadId: ThreadId, text: string, ok: boolean): void {
  const thread = ctx.threads.get(threadId);
  if (!thread) return;
  const turn = thread.turns.at(-1);
  const at = ctx.now();
  if (turn && (turn.status === 'running' || turn.status === 'queued')) {
    Object.assign(turn, { status: ok ? 'done' : 'error', finishedAt: at, error: ok ? null : text,
      usage: ok ? { inputTokens: 1400, outputTokens: 320, cacheReadTokens: 2600, cacheWriteTokens: 0, costUsdEquivalent: 0.018 } : null });
  }
  const message: Message = { id: `m-${threadId}-${++ctx.seq}`, threadId, turnId: turn?.id ?? `turn-${threadId}`, role: 'assistant', parts: [{ type: 'text', text }], state: 'complete', createdAt: at };
  thread.messages.push(message);
  thread.status = 'idle';
  ctx.emitToThread(threadId, 'message.started', structuredClone(message));
  ctx.emitToThread(threadId, 'message.completed', { threadId, messageId: message.id, state: 'complete' });
  ctx.touch(thread);
}

/** The column graph's demo on `?fake=1&team=1`: a scan done, a review fanned out over three files, two still running. */
function seedWorkflowDemo(ctx: FakeContext, rootId: ThreadId): void {
  ctx.workflowLag = -150_000;
  ctx.workflows.hold(() => {
    const run = ctx.workflows.start(rootId, {
      name: 'Review the parser',
      limits: { maxConcurrent: 2 },
      steps: [
        { id: 'scan', title: 'List changed files', profile: 'implementer', task: 'List the source files of src/parser that changed this week.', output: { files: ['string'] } },
        { id: 'review', title: 'Review each file', profile: 'reviewer', forEach: 'scan.files', task: 'Review {{item}} for malformed-input bugs. Do not edit files.', output: { bugs: [{ line: 'number', text: 'string' }] } },
        { id: 'fix', title: 'Fix the bugs', profile: 'implementer', when: { path: 'review.bugs', notEmpty: true }, task: 'Fix these bugs, one commit each: {{review.bugs}}' },
        { id: 'tests', title: 'Add regression tests', profile: 'implementer', when: { path: 'review.bugs', notEmpty: true }, task: 'Add one failing test per bug, in test/parser only: {{review.bugs}}' },
        { id: 'report', title: 'Write the report', profile: 'reviewer', after: ['fix', 'tests'], task: 'Summarize what was reviewed and fixed: {{review}}' }
      ]
    }, 'demo-workflow', undefined, 'agent');
    ctx.workflowLag = -110_000;
    ctx.workflows.finish(run.id, 'scan');
    ctx.workflowLag = -45_000;
    ctx.workflows.finish(run.id, 'review#0');
  });
  ctx.workflowLag = 0;
}

export function pumpDelegation(ctx: FakeContext, rootId: ThreadId): void {
  const config = delegationConfig(ctx, rootId);
  if (ctx.thread(rootId).archived || !config.enabled || config.paused) return;
  const rows = ctx.delegationAgents.get(rootId) ?? [];
  for (const row of rows) {
    const thread = ctx.thread(row.threadId);
    const turn = thread.turns.at(-1);
    if (thread.status !== 'queued' || turn?.status !== 'queued') continue;
    ctx.scheduler.queued = ctx.scheduler.queued.filter(entry => entry.turnId !== turn.id);
    ctx.scheduler.queued.forEach((entry, index) => { entry.position = index + 1; });
    ctx.startTurn(thread.id, row.task, [], 'delegation', undefined, turn);
  }
}

function directChildren(ctx: FakeContext, threadId: ThreadId, agentId?: ThreadId) {
  if (typeof threadId !== 'string' || !threadId || (agentId !== undefined && (typeof agentId !== 'string' || !agentId))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'threadId and agentId: expected nonempty strings' });
  if (ctx.thread(threadId).parentThreadId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'threadId: expected the parent of direct delegated children' });
  const rows = ctx.delegationAgents.get(threadId) ?? [];
  if (agentId !== undefined && !rows.some(row => row.threadId === agentId && ctx.thread(agentId).parentThreadId === threadId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'agentId: expected a direct delegated child of threadId' });
  return agentId === undefined ? rows : rows.filter(row => row.threadId === agentId);
}

function waitDelegation(ctx: FakeContext, params: RpcParams<'delegation.wait'>): Promise<DelegationWaitResult> {
  const timeout = params.timeoutMs === undefined ? 600_000 : params.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 3_600_000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'timeoutMs: expected an integer from 0 to 3600000' });
  directChildren(ctx, params.threadId, params.agentId);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const subscriptions: (() => void)[] = [];
    const cleanup = () => { finished = true; subscriptions.forEach(off => off()); if (timer !== undefined) clearTimeout(timer); };
    const inspect = (timedOut = false) => {
      if (finished) return;
      try {
        directChildren(ctx, params.threadId, params.agentId);
        const agents = delegationView(ctx, params.threadId).agents.filter(agent => params.agentId === undefined || agent.thread.id === params.agentId);
        const waiting = agents.some(agent => agent.lastTurn !== null && ['queued', 'running'].includes(agent.lastTurn.status));
        if (waiting && !timedOut) return;
        cleanup();
        resolve({ state: waiting ? 'waiting_for_children' : params.agentId && agents.some(agent => agent.resultRef) ? 'result_available' : 'settled', timedOut, agents });
      } catch (error) { cleanup(); reject(error); }
    };
    subscriptions.push(ctx.bus.on('turn.finished', () => inspect()), ctx.bus.on('delegation.changed', () => inspect()), ctx.bus.on('thread.removed', () => inspect()));
    subscriptions.push(ctx.bus.onState(state => {
      if (state !== 'ready') { cleanup(); reject(new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation.wait: connection closed' })); }
    }));
    timer = setTimeout(() => inspect(true), timeout);
    inspect();
  });
}

export function delegationMethods(ctx: FakeContext) {
  return {
    'delegation.wait': async params => waitDelegation(ctx, params),
    'delegation.result': async params => {
      directChildren(ctx, params.threadId, params.agentId);
      if (typeof params.turnId !== 'string' || !params.turnId) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'turnId: expected a nonempty string' });
      const child = ctx.thread(params.agentId);
      const turn = child.turns.find(turn => turn.id === params.turnId);
      if (!turn || ['queued', 'running'].includes(turn.status)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'turnId: expected a terminal turn of the named direct child' });
      const offset = params.offset === undefined ? 0 : params.offset, limit = params.limit === undefined ? 16_000 : params.limit;
      const full = child.messages.filter(message => message.turnId === turn.id && message.role === 'assistant').flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
      const chars = Array.from(full);
      if (!Number.isInteger(offset) || offset < 0 || offset > chars.length) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `offset: expected an integer from 0 to ${chars.length}` });
      if (!Number.isInteger(limit) || limit < 1 || limit > 16_000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'limit: expected an integer from 1 to 16000' });
      let text = chars.slice(offset, offset + limit).join('').slice(0, 16_000);
      if (text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff) text = text.slice(0, -1);
      const next = offset + Array.from(text).length;
      return { resultRef: { agentId: params.agentId, turnId: params.turnId }, text, offset, nextOffset: next < chars.length ? next : null, total: chars.length };
    },
    'delegation.models': async ({ threadId }) => {
      const parent = ctx.thread(delegationRoot(ctx, threadId));
      return { anyModel: delegationConfig(ctx, parent.id).anyModel !== false, choices: modelChoices(ctx, parent), unavailable: [] };
    },
    'delegation.get': async ({ threadId }) => {
      return delegationView(ctx, delegationRoot(ctx, threadId), threadId);
    },
    'delegation.configure': async ({ threadId, config: value }) => {
      const root = delegationRoot(ctx, threadId);
      if (root !== threadId || !value || typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean' || !Array.isArray(value.profiles) || value.profiles.length > 16) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'delegation.configure requires a parent thread and a valid config' });
      }
      const profiles = value.profiles.map(profile => {
        const provider = ctx.providers.find(entry => entry.id === profile.providerId);
        const account = ctx.accounts.find(entry => entry.id === profile.accountId);
        if (!profile.id || !profile.name.trim() || !provider || !account || account.providerId !== provider.id || !profile.model) {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'each profile needs a unique id, name, provider, account and model' });
        }
        return { ...profile, name: profile.name.trim() };
      });
      if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'profile ids must be unique' });
      const config: DelegationConfig = {
        enabled: value.enabled,
        paused: value.paused,
        profiles,
        anyModel: value.anyModel !== false
      };
      ctx.delegationConfigs.set(root, structuredClone(config));
      if (!config.enabled || config.paused) await stopDelegation(ctx, root);
      ctx.emit('delegation.changed', { threadId: root });
      return delegationView(ctx, root);
    },
    'delegation.spawn': async (params) => {
      const parent = ctx.thread(params.threadId);
      if (parent.parentThreadId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation supports one level' });
      const task = params.task.trim();
      if (!task || task.length > 12000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'task must contain 1 to 12000 characters' });
      const fingerprint = JSON.stringify([params.profileId ?? null, params.model ?? null, params.effort ?? null, params.speed ?? null, task, params.title ?? null]);
      const requestKey = `${parent.id}:${params.requestId}`;
      const prior = ctx.delegationRequests.get(requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
        const row = (ctx.delegationAgents.get(parent.id) ?? []).find(entry => entry.threadId === prior.threadId);
        if (!row) throw ctx.notFound('delegated agent', prior.threadId);
        return delegatedAgent(ctx, row);
      }
      const config = delegationConfig(ctx, parent.id);
      if (parent.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot start delegation on an archived parent' });
      if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
      const rows = ctx.delegationAgents.get(parent.id) ?? [];
      const profileId = params.profileId ?? CONVERSATION_PROFILE_ID;
      const profile: ChildRoute | undefined = params.model !== undefined ? pickModel(ctx, parent, config, params.model, params.effort) : config.profiles.find(entry => entry.id === profileId)
        ?? (profileId === CONVERSATION_PROFILE_ID ? { id: CONVERSATION_PROFILE_ID, name: parent.model ?? parent.providerId, providerId: parent.providerId, accountId: parent.accountId, model: parent.model, effort: parent.effort ?? null } : undefined);
      if (!profile) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'unknown delegation profile' });
      const speed = pickSpeed(ctx, profile, params.speed);
      const id = `t-${++ctx.seq}`;
      const at = ctx.now();
      const child: Thread = {
        ...parent,
        id,
        parentThreadId: parent.id,
        title: params.title?.trim() || task.split('\n')[0]!.slice(0, 80),
        titleSource: 'user',
        providerId: profile.providerId,
        accountId: profile.accountId,
        model: profile.model,
        effort: params.model === undefined && params.effort !== undefined ? params.effort : profile.effort,
        speed,
        status: 'idle', unread: false, archived: false, pinned: false,
        sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, moveNote: null,
        createdAt: at, updatedAt: at, messagesBefore: null, messages: [], turns: [], commands: []
      };
      delete child.pullRequest;
      delete child.lastUserMessageAt;
      ctx.threads.set(id, child);
      const row = { threadId: id, profileId: profile.id, task };
      ctx.delegationAgents.set(parent.id, [...rows, row]);
      ctx.delegationTurns.set(parent.id, (ctx.delegationTurns.get(parent.id) ?? 0) + 1);
      ctx.emit('thread.created', structuredClone(toSummary(child)));
      ctx.startTurn(id, task, [], 'delegation');
      const agent = delegatedAgent(ctx, row);
      ctx.delegationRequests.set(requestKey, { fingerprint, threadId: id });
      ctx.emit('delegation.changed', { threadId: parent.id });
      return structuredClone(agent);
    },
    'delegation.send': async (params) => {
      if (params.requestId.startsWith('result:')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId prefix result: is reserved' });
      const sender = ctx.thread(params.threadId);
      const recipient = ctx.thread(params.toThreadId);
      const root = delegationRoot(ctx, sender.id);
      const direct = sender.parentThreadId ? recipient.id === sender.parentThreadId : recipient.parentThreadId === sender.id;
      if (!direct) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'toThreadId must be the parent or a direct child' });
      const body = params.text.trim();
      if (!body || body.length > 4000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'text must contain 1 to 4000 characters' });
      const key = `${sender.id}:${params.requestId}`;
      const fingerprint = JSON.stringify([recipient.id, body]);
      const prior = ctx.delegationSendRequests.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
        return structuredClone(prior.letter);
      }
      const config = delegationConfig(ctx, root);
      if (ctx.thread(root).archived || sender.archived || recipient.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation messages require an unarchived parent and threads' });
      if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
      const letter: AgentLetter = {
        id: `letter-${++ctx.seq}`,
        origin: 'user',
        from: { coreId: 'local', threadId: sender.id, title: sender.title, project: ctx.projects.find(project => project.id === sender.projectId)?.name, machine: 'Boite', resources: '', status: sender.status, mode: 'team' },
        to: { coreId: 'local', threadId: recipient.id }, toTitle: recipient.title, toProject: ctx.projects.find(project => project.id === recipient.projectId)?.name, toMachine: 'Boite',
        text: body, replyTo: null, createdAt: ctx.now(), expiresAt: ctx.now() + 15 * 60_000,
        status: 'received', error: null
      };
      ctx.delegationLetters.set(root, [...(ctx.delegationLetters.get(root) ?? []), letter]);
      ctx.delegationSendRequests.set(key, { fingerprint, letter });
      ctx.emit('delegation.changed', { threadId: root });
      return structuredClone(letter);
    },
    'delegation.stop': async (params) => {
      const caller = ctx.thread(params.threadId);
      const root = caller.parentThreadId ?? caller.id;
      if (caller.parentThreadId && params.agentId && params.agentId !== caller.id) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a delegated child can only stop itself' });
      }
      const target = params.agentId ?? (caller.parentThreadId ? caller.id : undefined);
      const stopped = await stopDelegation(ctx, root, target);
      ctx.emit('delegation.changed', { threadId: root });
      return { stopped };
    },
  } satisfies Partial<FakeMethods>;
}
