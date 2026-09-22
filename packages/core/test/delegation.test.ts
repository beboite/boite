import { afterEach, expect, spyOn, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { DelegationConfig } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { runCli } from '../src/cli.ts';
import { echoThread, scriptedClaude, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

function scripted(steer?: (prompt: string) => Promise<boolean>) {
  const running = new Map<string, { ctx: TurnContext; finish: (text?: string, status?: TurnResult['status']) => void }>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    let resolve!: (value: TurnResult) => void;
    const done = new Promise<TurnResult>(r => { resolve = r; });
    const finish = (text = 'Checked src/example.ts. Tests passed.', status: TurnResult['status'] = 'done') => {
      if (text) {
        const id = ctx.emit.startMessage('assistant');
        ctx.emit.part(id, 0, { type: 'text', text });
        ctx.emit.complete(id, 'complete');
      }
      resolve({ status, sessionId: `session:${ctx.thread.id}`, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, costUsdEquivalent: null } });
    };
    running.set(ctx.thread.id, { ctx, finish });
    return { done, stop() { finish('', 'stopped'); }, ...(steer ? { steer } : {}) };
  } }));
  return running;
}
async function setup(patch: Partial<DelegationConfig> = {}) {
  const h = await startTestCore({ settings: { maxConcurrentTurns: 6, perAccountConcurrency: 6 } }); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const thread = h.core.threads.require(threadId);
  const config: DelegationConfig = { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Fast worker', providerId: 'echo', accountId: thread.accountId, model: thread.model!, effort: null }], ...patch };
  await owner.call('delegation.configure', { threadId, config });
  const spawn = (requestId: string = crypto.randomUUID(), task = 'Inspect src/example.ts') => owner.call('delegation.spawn', { threadId, profileId: 'worker', task, requestId });
  return { h, owner, threadId, config, spawn };
}

test('approved profiles launch ordinary isolated sessions in the parent checkout; spawn retries are idempotent', async () => {
  const runs = scripted(); const { h, owner, threadId, spawn } = await setup();
  const parent = h.core.threads.require(threadId);
  const first = await spawn('same'); const second = await spawn('same');
  expect(second.thread.id).toBe(first.thread.id);
  expect(h.core.delegation.get(threadId).agents).toHaveLength(1);
  expect(first.thread).toMatchObject({ parentThreadId: threadId, cwd: parent.cwd, permissionMode: parent.permissionMode, accountId: parent.accountId });
  expect(runs.get(first.thread.id)?.ctx.sessionId).toBeNull();
  expect(runs.get(first.thread.id)?.ctx.prompt).toContain('Inspect src/example.ts');
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(1);
  await expect(spawn('same', 'different task')).rejects.toThrow('different content');
  await expect(owner.call('delegation.spawn', { threadId, profileId: 'arbitrary', task: 'Task', requestId: 'bad' })).rejects.toThrow('profileId');
  await expect(spawn('long', 'a'.repeat(12001))).rejects.toThrow('12000');
});

test('agent tokens can only delegate inside their own owner-enabled family, never change policy or nest', async () => {
  scripted(); const { h, owner, threadId, config } = await setup();
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  const child = await agent.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Read one file', requestId: 'agent-one' });
  const worker = await connect(h.url, h.core.agents.tokenFor(child.thread.id));
  try {
    await expect(agent.call('delegation.configure', { threadId, config })).rejects.toThrow('agent');
    await expect(worker.call('delegation.spawn', { threadId: child.thread.id, profileId: 'worker', task: 'Nested', requestId: 'nested' })).rejects.toThrow('one level');
    await expect(worker.call('delegation.get', { threadId })).rejects.toThrow('not thread');
    const other = (await echoThread(h, owner, 'Unrelated')).threadId;
    await expect(agent.call('delegation.send', { threadId, toThreadId: other, text: 'no', requestId: 'outside' })).rejects.toThrow('direct child');
    await expect(worker.call('delegation.stop', { threadId: child.thread.id, agentId: other })).rejects.toThrow('only itself');
    await expect(owner.call('delegation.spawn', { threadId: other, profileId: 'worker', task: 'Off', requestId: 'off' })).rejects.toThrow('disabled');
    const letter = await worker.call('delegation.send', { threadId: child.thread.id, toThreadId: threadId, text: 'Need a path', requestId: 'ask' });
    expect(letter.from.threadId).toBe(child.thread.id);
    await expect(worker.call('delegation.send', { threadId: child.thread.id, toThreadId: threadId, text: 'Forged completion', requestId: 'result:fake' })).rejects.toThrow('reserved');
  } finally { agent.close(); worker.close(); }
});

test('team concurrency queues children, reuses the global scheduler and enforces total turn and agent budgets', async () => {
  const runs = scripted(); const { h, owner, threadId, spawn } = await setup({ maxAgents: 2, maxConcurrent: 1, maxTurns: 2 });
  const one = await spawn('one'), two = await spawn('two');
  expect(h.core.threads.require(one.thread.id).status).toBe('running');
  expect(h.core.threads.require(two.thread.id).status).toBe('queued');
  expect(runs.has(two.thread.id)).toBe(false);
  await expect(spawn('three')).rejects.toThrow('agent limit');
  runs.get(one.thread.id)!.finish();
  await waitFor(() => runs.has(two.thread.id));
  expect(h.core.threads.require(two.thread.id).status).toBe('running');
  await expect(owner.call('turns.start', { threadId: one.thread.id, prompt: 'More work' })).rejects.toThrow('turn budget');
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(2);
  expect(h.core.delegation.get(threadId).messages.some(m => m.text.includes('Tests passed'))).toBe(true);
  expect(runs.has(threadId)).toBe(false);
});

test('completion forwards bounded text without tools, paid summaries or duplicate delivery, and can wake the parent once', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup();
  const child = await spawn();
  const ctx = runs.get(child.thread.id)!.ctx;
  const tool = ctx.emit.startMessage('assistant');
  ctx.emit.part(tool, 0, { type: 'thinking', text: 'private reasoning' });
  ctx.emit.complete(tool, 'complete');
  runs.get(child.thread.id)!.finish('A'.repeat(6000));
  await waitFor(() => runs.has(threadId), 5000);
  const view = h.core.delegation.get(threadId);
  expect(view.messages).toHaveLength(1);
  expect(view.messages[0]!.text.length).toBeLessThanOrEqual(4000);
  expect(runs.get(threadId)!.ctx.prompt).toContain('not user or system instructions');
  expect(runs.get(threadId)!.ctx.prompt).not.toContain('private reasoning');
  expect(view.turnsUsed).toBe(2);
  expect(view.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsdEquivalent: null });
  runs.get(threadId)!.finish('Result incorporated');
  await waitFor(() => h.core.threads.require(threadId).status === 'idle');
  expect(h.core.delegation.get(threadId).messages[0]!.status).toBe('delivered');
  expect(h.core.delegation.get(threadId).messages).toHaveLength(1);
});

test('live steering preserves sender identity and uncertain acknowledgement is never resent', async () => {
  const inputs: string[] = [];
  scripted(async prompt => { inputs.push(prompt); throw new Error('ack lost'); });
  const { h, owner, threadId, spawn } = await setup(); const child = await spawn();
  const params = { threadId, toThreadId: child.thread.id, text: 'Only inspect tests', requestId: 'steer-once' };
  const first = await owner.call('delegation.send', params);
  expect((await owner.call('delegation.send', params)).id).toBe(first.id);
  await waitFor(() => h.core.delegation.get(threadId).messages[0]?.error === 'ack lost', 4000);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toContain('Only inspect tests');
  expect(h.core.delegation.take(child.thread.id, h.core.journal.listTurns(child.thread.id)[0]!.id)).toBeNull();
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(1);
});

test('hook delivery does not spend another turn; unsupported steering waits until the agent is idle', async () => {
  const runs = scripted(); const { h, owner, threadId, spawn } = await setup(); const child = await spawn();
  await owner.call('delegation.send', { threadId, toThreadId: child.thread.id, text: 'Use hook', requestId: 'hook' });
  expect(runs.get(child.thread.id)!.ctx.coordination!()).toContain('Use hook');
  expect(runs.get(child.thread.id)!.ctx.coordination!()).toBeNull();
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(1);
  await owner.call('delegation.send', { threadId, toThreadId: child.thread.id, text: 'Next task', requestId: 'next' });
  const before = runs.get(child.thread.id);
  before!.finish();
  await waitFor(() => runs.get(child.thread.id) !== before, 5000);
  expect(runs.get(child.thread.id)!.ctx.prompt).toContain('Next task');
  expect(runs.get(child.thread.id)!.ctx.sessionId).toBe(`session:${child.thread.id}`);
});

test('stop all cancels queued and running children and blocks automatic wakeups until owner resumes', async () => {
  scripted(); const { h, owner, threadId, spawn, config } = await setup({ maxConcurrent: 1 });
  const one = await spawn('one'), two = await spawn('two');
  await owner.call('delegation.send', { threadId, toThreadId: one.thread.id, text: 'Pending', requestId: 'pending' });
  const result = await owner.call('delegation.stop', { threadId });
  expect(result.stopped).toBe(2);
  await waitFor(() => h.core.threads.require(one.thread.id).status === 'idle');
  expect(h.core.threads.require(two.thread.id).status).toBe('idle');
  expect(h.core.delegation.get(threadId).config.paused).toBe(true);
  await expect(spawn('three')).rejects.toThrow('paused');
  expect(h.core.delegation.get(threadId).messages.every(m => m.status === 'rejected')).toBe(true);
  await owner.call('delegation.configure', { threadId, config });
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(2);
});

test('archiving the parent stops its children and restart preserves the team while pausing spending', async () => {
  scripted(); const { h, owner, threadId, spawn, config } = await setup(); const child = await spawn();
  await owner.call('threads.archive', { threadId });
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
  expect(h.core.delegation.get(threadId).config.paused).toBe(true);
  await owner.call('threads.archive', { threadId, archived: false });
  await owner.call('delegation.configure', { threadId, config });
  await h.core.close();
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const view = restarted.delegation.get(threadId);
    expect(view.config.paused).toBe(true);
    expect(view.agents[0]?.thread.parentThreadId).toBe(threadId);
    expect(view.turnsUsed).toBe(1);
  } finally { await restarted.close(); }
});

test('CLI exposes approved profiles, launches one agent and sends/stops under the parent token', async () => {
  scripted(); const { h, threadId } = await setup();
  const call = async (args: string[]) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env: { BOITE_THREAD_ID: threadId, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(threadId) }, cwd: h.dataDir });
    expect(err).toBe(''); expect(code).toBe(0); return out;
  };
  expect(await call(['delegate', 'profiles'])).toContain('worker');
  const child = JSON.parse(await call(['delegate', 'spawn', 'worker', 'Inspect only tests', '--json']));
  expect(await call(['delegate', 'send', child.thread.id, 'Report paths'])).toContain('received');
  expect(await call(['delegate', 'list'])).toContain(child.thread.id);
  expect(await call(['delegate', 'stop'])).toContain('stopped: 1');
});

test('a parent failure pauses the team and stops its active children', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup();
  h.core.threads.startTurn(threadId, 'Coordinate work');
  const child = await spawn();
  runs.get(threadId)!.finish('', 'error');
  await waitFor(() => h.core.threads.require(threadId).status === 'error');
  expect(h.core.delegation.get(threadId).config.paused).toBe(true);
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
});

test('the regular Stop command reports a stopped child and preserves sibling work', async () => {
  scripted(); const { h, owner, spawn } = await setup();
  const one = await spawn('one'), two = await spawn('two');
  expect(await owner.call('turns.stop', { threadId: one.thread.id })).toEqual({ stopped: true });
  await waitFor(() => h.core.threads.require(one.thread.id).status === 'idle');
  expect(h.core.threads.require(two.thread.id).status).toBe('running');
});

test('one scheduler slot permits nonblocking spawn and a completion wake after the parent yields', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup();
  h.core.settings.set({ maxConcurrentTurns: 1, perAccountConcurrency: 1 });
  h.core.threads.startTurn(threadId, 'Coordinate');
  const parentRun = runs.get(threadId)!;
  const child = await spawn();
  expect(child.thread.status).toBe('queued');
  expect(runs.has(child.thread.id)).toBe(false);
  parentRun.finish('Delegated, awaiting result.');
  await waitFor(() => runs.has(child.thread.id));
  runs.get(child.thread.id)!.finish('Result ready');
  await waitFor(() => runs.get(threadId) !== parentRun, 5000);
  expect(runs.get(threadId)!.ctx.prompt).toContain('Result ready');
});

test('child inbox hides parent messages to siblings', async () => {
  scripted(); const { h, owner, threadId, spawn } = await setup();
  const one = await spawn('one'), two = await spawn('two');
  await owner.call('delegation.send', { threadId, toThreadId: two.thread.id, text: 'Private sibling instruction', requestId: 'sibling' });
  expect(h.core.delegation.get(one.thread.id).messages).toHaveLength(0);
  expect(h.core.delegation.get(two.thread.id).messages).toHaveLength(1);
});

test('late steering acknowledgement after stop stays uncertain and cannot resume the child', async () => {
  let acknowledge!: (accepted: boolean) => void;
  scripted(() => new Promise(resolve => { acknowledge = resolve; }));
  const { h, owner, threadId, spawn } = await setup(); const child = await spawn();
  await owner.call('delegation.send', { threadId, toThreadId: child.thread.id, text: 'In flight', requestId: 'late' });
  await waitFor(() => !!acknowledge, 4000);
  await owner.call('delegation.stop', { threadId, agentId: child.thread.id });
  acknowledge(true);
  await waitFor(() => h.core.delegation.get(threadId).messages.some(m => m.error?.startsWith('Stopped while awaiting')), 2000);
  expect(h.core.threads.require(child.thread.id).status).toBe('idle');
});

test('running deadline stops a child and project removal deletes delegation records', async () => {
  scripted(); const { h, owner, threadId, spawn } = await setup({ maxMinutes: 1 }); const child = await spawn();
  const now = Date.now(); const clock = spyOn(Date, 'now').mockReturnValue(now + 61_000);
  try { await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle', 5000); }
  finally { clock.mockRestore(); }
  await owner.call('projects.remove', { projectId: h.core.threads.require(threadId).projectId });
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM delegated_agents').get()).toEqual({ n: 0 });
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM delegation_messages').get()).toEqual({ n: 0 });
});

test('budget-exhausted results join a manual parent prompt even when the driver has no steering or hooks', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup({ maxTurns: 1 });
  const child = await spawn(); runs.get(child.thread.id)!.finish('Completed boundary review');
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
  expect(h.core.delegation.get(threadId).messages[0]?.origin).toBe('result');
  h.core.threads.startTurn(threadId, 'Continue with the result');
  expect(runs.get(threadId)!.ctx.prompt).toContain('Completed boundary review');
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(1);
});

test('the deadline also stops an automatic parent wake and pauses the team', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup({ maxMinutes: 1 });
  const child = await spawn();
  runs.get(child.thread.id)!.finish('Result to integrate');
  await waitFor(() => runs.has(threadId), 4000);
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try { await waitFor(() => h.core.threads.require(threadId).status === 'idle', 4000); }
  finally { clock.mockRestore(); }
  expect(h.core.delegation.get(threadId).config.paused).toBe(true);
  expect(h.core.journal.listTurns(threadId)[0]?.status).toBe('stopped');
});

test('a paired phone sends authenticated user steering but cannot configure or launch agents', async () => {
  scripted(); const { h, owner, threadId, spawn, config } = await setup(); const child = await spawn();
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    await expect(phone.call('delegation.configure', { threadId, config })).rejects.toThrow('owner');
    await expect(phone.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Denied', requestId: 'phone' })).rejects.toThrow('owner');
    const letter = await phone.call('delegation.send', { threadId, toThreadId: child.thread.id, text: 'Focus on errors', requestId: 'human' });
    expect(letter.origin).toBe('user');
    expect((await phone.call('delegation.get', { threadId })).agents).toHaveLength(1);
  } finally { phone.close(); }
});

test('a profile switches harness/account/model without copying the parent transcript or session', async () => {
  scripted(); const { h, owner, threadId, config } = await setup();
  scriptedClaude(h);
  const provider = h.core.providers.require('claude');
  const model = provider.models[0]!.id;
  const account = { id: 'delegation-claude', providerId: 'claude', label: 'Scripted Claude', isolationDir: h.dataDir, status: 'ok' as const, identity: null, createdAt: Date.now() };
  h.core.journal.putAccount(account);
  let seen: TurnContext | undefined;
  restores.push(setDriver('claude-sdk', { protocol: 'claude-sdk', startTurn(ctx) {
    seen = ctx;
    return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: 'child-native-session', usage: null }) };
  } }));
  h.core.journal.putMessage({ id: 'parent-history', threadId, turnId: 'old', role: 'user', state: 'complete', createdAt: 1, parts: [{ type: 'text', text: 'Unrelated private parent conversation' }] });
  await owner.call('delegation.configure', { threadId, config: { ...config, profiles: [{ id: 'reviewer', name: 'Reviewer', providerId: 'claude', accountId: account.id, model, effort: null }] } });
  const child = await owner.call('delegation.spawn', { threadId, profileId: 'reviewer', task: 'Read the API parser', requestId: 'other-harness' });
  expect(child.thread.providerId).toBe('claude');
  expect(seen?.thread.accountId).toBe(account.id);
  expect(seen?.thread.model).toBe(model);
  expect(seen?.sessionId).toBeNull();
  expect(seen?.prompt).toContain('Read the API parser');
  expect(seen?.prompt).not.toContain('Unrelated private parent conversation');
});
