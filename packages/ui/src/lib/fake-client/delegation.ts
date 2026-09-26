/** Delegation: a parent thread's team of child threads, their budget and letters. */
import { DEFAULT_DELEGATION_CONFIG, RpcErrorCode, type AgentLetter, type DelegatedAgent, type DelegationConfig, type DelegationProfile, type DelegationView, type Message, type Thread, type ThreadId, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { addUsage, emptyUsage, toSummary } from './shared';
import type { FakeContext, FakeMethods } from './context';

function delegationRoot(ctx: FakeContext, threadId: ThreadId): ThreadId {
  const thread = ctx.thread(threadId);
  return thread.parentThreadId ?? thread.id;
}

export function delegationConfig(ctx: FakeContext, rootId: ThreadId): DelegationConfig {
  return structuredClone(ctx.delegationConfigs.get(rootId) ?? DEFAULT_DELEGATION_CONFIG);
}

function delegatedAgent(ctx: FakeContext, row: { threadId: ThreadId; profileId: string; task: string }): DelegatedAgent {
  const thread = ctx.thread(row.threadId);
  const lastTurn = thread.turns.at(-1) ?? null;
  const result = lastTurn && !['queued', 'running'].includes(lastTurn.status)
    ? thread.messages.filter(message => message.turnId === lastTurn.id && message.role === 'assistant').at(-1)?.parts
        .filter(part => part.type === 'text').map(part => part.text).join('\n').trim().slice(0, 4000) || lastTurn.error
    : null;
  return { thread: structuredClone(toSummary(thread)), profileId: row.profileId, task: row.task, lastTurn: structuredClone(lastTurn), result: result || null };
}

function delegationView(ctx: FakeContext, rootId: ThreadId, callerId = rootId): DelegationView {
  ctx.thread(rootId);
  const rows = ctx.delegationAgents.get(rootId) ?? [];
  let usage = emptyUsage();
  for (const row of rows) for (const turn of ctx.thread(row.threadId).turns) if (turn.usage) usage = addUsage(usage, turn.usage);
  return {
    rootThreadId: rootId,
    config: delegationConfig(ctx, rootId),
    agents: rows.map(row => delegatedAgent(ctx, row)),
    messages: structuredClone((ctx.delegationLetters.get(rootId) ?? []).filter(letter => callerId === rootId || letter.from.threadId === callerId || letter.to.threadId === callerId)),
    turnsUsed: ctx.delegationTurns.get(rootId) ?? 0,
    usage
  };
}

export async function stopDelegation(ctx: FakeContext, rootId: ThreadId, agentId?: ThreadId): Promise<number> {
  const rows = ctx.delegationAgents.get(rootId) ?? [];
  const selected = agentId ? rows.filter(row => row.threadId === agentId) : rows;
  if (agentId && selected.length === 0) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'agentId must name a direct child' });
  if (!agentId) ctx.delegationConfigs.set(rootId, { ...delegationConfig(ctx, rootId), paused: true });
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
  const reviewer: DelegationProfile = { id: 'reviewer', name: 'Reviewer', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-sonnet-5', effort: 'high' };
  const implementer: DelegationProfile = { id: 'implementer', name: 'Implementer', providerId: 'codex', accountId: 'a-codex', model: 'gpt-5.6-sol', effort: 'medium' };
  ctx.delegationConfigs.set(root.id, { enabled: true, paused: false, maxAgents: 4, maxConcurrent: 2, maxTurns: 12, maxMinutes: 30, profiles: [reviewer, implementer] });
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
export function workflowChild(ctx: FakeContext, root: Thread, profile: DelegationProfile, title: string, task: string): ThreadId {
  const id = `t-${++ctx.seq}`;
  const at = ctx.now();
  const turn: Turn = { id: `turn-${id}`, threadId: id, status: 'running', queuedAt: at, startedAt: at, finishedAt: null, usage: null, error: null };
  const child: Thread = {
    ...root, id, parentThreadId: root.id, title, titleSource: 'user',
    providerId: profile.providerId, accountId: profile.accountId, model: profile.model, effort: profile.effort,
    status: 'running', unread: false, archived: false, pinned: false,
    sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, activity: undefined,
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
        { id: 'report', title: 'Write the report', profile: 'reviewer', after: ['fix'], task: 'Summarize what was reviewed and fixed: {{review}}' }
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
  if (!config.enabled || config.paused) return;
  const rows = ctx.delegationAgents.get(rootId) ?? [];
  let running = rows.filter(row => ['running', 'waiting'].includes(ctx.thread(row.threadId).status)).length;
  for (const row of rows) {
    if (running >= config.maxConcurrent) break;
    const thread = ctx.thread(row.threadId);
    const turn = thread.turns.at(-1);
    if (thread.status !== 'queued' || turn?.status !== 'queued') continue;
    ctx.scheduler.queued = ctx.scheduler.queued.filter(entry => entry.turnId !== turn.id);
    ctx.scheduler.queued.forEach((entry, index) => { entry.position = index + 1; });
    ctx.startTurn(thread.id, row.task, [], 'delegation', undefined, turn);
    running += 1;
  }
}

export function delegationMethods(ctx: FakeContext) {
  return {
    'delegation.get': async ({ threadId }) => {
      return delegationView(ctx, delegationRoot(ctx, threadId), threadId);
    },
    'delegation.configure': async ({ threadId, config: value }) => {
      const root = delegationRoot(ctx, threadId);
      if (root !== threadId || !value || typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean' || !Array.isArray(value.profiles) || value.profiles.length > 16) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'delegation.configure requires a parent thread and a valid config' });
      }
      const integer = (field: keyof Pick<DelegationConfig, 'maxAgents' | 'maxConcurrent' | 'maxTurns' | 'maxMinutes'>, max: number): number => {
        const number = value[field];
        if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `${field} must be an integer from 1 to ${max}` });
        return number;
      };
      const profiles = value.profiles.map(profile => {
        const provider = ctx.providers.find(entry => entry.id === profile.providerId);
        const account = ctx.accounts.find(entry => entry.id === profile.accountId);
        if (!profile.id || !profile.name.trim() || !provider || !account || account.providerId !== provider.id || !profile.model) {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'each profile needs a unique id, name, provider, account and model' });
        }
        return { ...profile, name: profile.name.trim() };
      });
      if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'profile ids must be unique' });
      if (value.enabled && profiles.length === 0) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'choose at least one profile before enabling delegation' });
      const config: DelegationConfig = {
        enabled: value.enabled,
        paused: value.paused,
        maxAgents: integer('maxAgents', 8),
        maxConcurrent: integer('maxConcurrent', 8),
        maxTurns: integer('maxTurns', 100),
        maxMinutes: integer('maxMinutes', 120),
        profiles
      };
      if (config.maxConcurrent > config.maxAgents) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'maxConcurrent must not exceed maxAgents' });
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
      const fingerprint = JSON.stringify([params.profileId, task, params.title ?? null]);
      const requestKey = `${parent.id}:${params.requestId}`;
      const prior = ctx.delegationRequests.get(requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
        const row = (ctx.delegationAgents.get(parent.id) ?? []).find(entry => entry.threadId === prior.threadId);
        if (!row) throw ctx.notFound('delegated agent', prior.threadId);
        return delegatedAgent(ctx, row);
      }
      const config = delegationConfig(ctx, parent.id);
      if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
      const rows = ctx.delegationAgents.get(parent.id) ?? [];
      if (rows.length >= config.maxAgents) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation agent limit reached' });
      if ((ctx.delegationTurns.get(parent.id) ?? 0) >= config.maxTurns) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation turn budget reached' });
      const running = rows.filter(row => ['queued', 'running', 'waiting'].includes(ctx.thread(row.threadId).status)).length;
      const profile = config.profiles.find(entry => entry.id === params.profileId);
      if (!profile) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'unknown delegation profile' });
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
        effort: profile.effort,
        status: 'idle', unread: false, archived: false, pinned: false,
        sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null,
        createdAt: at, updatedAt: at, messagesBefore: null, messages: [], turns: [], commands: []
      };
      delete child.pullRequest;
      delete child.lastUserMessageAt;
      ctx.threads.set(id, child);
      const row = { threadId: id, profileId: profile.id, task };
      ctx.delegationAgents.set(parent.id, [...rows, row]);
      ctx.delegationTurns.set(parent.id, (ctx.delegationTurns.get(parent.id) ?? 0) + 1);
      ctx.emit('thread.created', structuredClone(toSummary(child)));
      const turn = running >= config.maxConcurrent
        ? { id: `turn-${++ctx.seq}`, threadId: id, status: 'queued' as const, queuedAt: at, startedAt: null, finishedAt: null, usage: null, error: null }
        : ctx.startTurn(id, task, [], 'delegation');
      if (turn.status === 'queued') {
        child.turns.push(turn);
        child.status = 'queued';
        ctx.scheduler.queued = [...ctx.scheduler.queued, { turnId: turn.id, threadId: id, position: ctx.scheduler.queued.length + 1, queuedAt: turn.queuedAt }];
        ctx.emit('scheduler.updated', structuredClone(ctx.scheduler));
      }
      const agent = delegatedAgent(ctx, row);
      ctx.delegationRequests.set(requestKey, { fingerprint, threadId: id });
      ctx.emit('delegation.changed', { threadId: parent.id });
      void turn;
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
      if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
      const letter: AgentLetter = {
        id: `letter-${++ctx.seq}`,
        origin: 'user',
        from: { coreId: 'local', threadId: sender.id, title: sender.title, machine: 'Boite', resources: '', status: sender.status, mode: 'team' },
        to: { coreId: 'local', threadId: recipient.id }, toTitle: recipient.title,
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
