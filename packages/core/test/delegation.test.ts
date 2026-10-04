import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { DelegationConfig, ProcessRecord, Turn } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { runCli } from '../src/cli.ts';
import { holdAccountTurns, echoThread, scriptedClaude, startTestCore, waitFor, type TestCore } from './harness.ts';

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
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const thread = h.core.threads.require(threadId);
  const config: DelegationConfig = { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Fast worker', providerId: 'echo', accountId: thread.accountId, model: thread.model!, effort: null }], ...patch };
  await owner.call('delegation.configure', { threadId, config });
  const spawn = (requestId: string = crypto.randomUUID(), task = 'Inspect src/example.ts') => owner.call('delegation.spawn', { threadId, profileId: 'worker', task, requestId });
  return { h, owner, threadId, config, spawn };
}

test('a CLI launched by a shell stays visible until its own exit, even with Boite delegation off', async () => {
  const { h, owner, threadId } = await setup({ enabled: false });
  const changed: string[] = [];
  const off = h.core.bus.onCommitted((name, payload) => {
    if (name === 'delegation.changed') changed.push((payload as { threadId: string }).threadId);
  });
  const shell: ProcessRecord = { threadId, pid: 7700, parentPid: process.pid, exe: 'pwsh.exe', commandLine: 'pwsh.exe -File review.ps1', startedAt: 100, exitedAt: null, exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
  const child: ProcessRecord = { ...shell, pid: 7701, parentPid: shell.pid, exe: 'C:\\tools\\claude.exe', commandLine: '"C:\\tools\\claude.exe" --print --model claude-opus-5-5 --effort xhigh "Review the audit"', startedAt: 110 };
  const live = spyOn(h.core.procs, 'liveOf').mockReturnValue([shell, child]);
  try {
    for (const record of [shell, child]) {
      h.core.journal.putProcess(record);
      h.core.bus.emit('process.started', record);
    }
    expect(changed).toEqual([threadId]);
    const view = await owner.call('delegation.get', { threadId });
    expect(view.agents).toEqual([]);
    expect(view.nativeAgents).toEqual([expect.objectContaining({ name: 'Claude Code', model: 'claude-opus-5-5', effort: 'xhigh', source: 'process', status: 'running', startedAt: child.startedAt })]);
    // A detached launch returning is not the child's completion.
    const shellExit = { ...shell, exitedAt: 120, exitCode: 0 };
    h.core.journal.putProcess(shellExit);
    h.core.bus.emit('process.exited', shellExit);
    live.mockReturnValue([child]);
    expect(h.core.delegation.get(threadId).nativeAgents[0]?.status).toBe('running');
    const exit = { ...child, exitedAt: 200, exitCode: 0 };
    h.core.journal.putProcess(exit);
    h.core.bus.emit('process.exited', exit);
    live.mockReturnValue([]);
    expect(changed).toEqual([threadId, threadId]);
    expect((await owner.call('delegation.get', { threadId })).nativeAgents[0]).toMatchObject({ source: 'process', status: 'done', finishedAt: 200 });
  } finally { live.mockRestore(); off(); }
});

test('an unclosed CLI trace stays in history with unknown status after core restart', async () => {
  const { h, threadId } = await setup();
  const shell: ProcessRecord = { threadId, pid: 7800, parentPid: process.pid, exe: 'pwsh.exe', commandLine: 'pwsh.exe review.ps1', startedAt: 100, exitedAt: 120, exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
  const child: ProcessRecord = { ...shell, pid: 7801, parentPid: shell.pid, exe: 'claude.exe', commandLine: 'claude.exe --print "Review"', startedAt: 110, exitedAt: null, exitCode: null };
  for (const record of [shell, child]) h.core.journal.putProcess(record);
  // The journal contains no exit, as when the previous core stopped abruptly.
  await h.core.close();
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(restarted.procs.liveOf(threadId)).toEqual([]);
    expect(restarted.delegation.get(threadId).nativeAgents).toEqual([expect.objectContaining({ source: 'process', status: 'unknown' })]);
    expect(restarted.journal.listProcesses(threadId, 10).find(record => record.pid === child.pid)?.exitedAt).toBeNull();
  } finally { await restarted.close(); }
});

test('load ticks keep team snapshots quiet while semantic changes notify every subscribed member once', async () => {
  scripted();
  const { h, threadId, spawn } = await setup();
  const children = await Promise.all([spawn('one'), spawn('two'), spawn('three')]);
  await Bun.sleep(0);
  const changed: string[] = [];
  const off = h.core.bus.onAny((name, payload) => {
    if (name === 'delegation.changed') changed.push((payload as { threadId: string }).threadId);
  });
  try {
    for (const child of children) {
      const thread = h.core.threads.require(child.thread.id);
      h.core.bus.emit('thread.updated', { ...thread, pendingAnswers: ['An answer awaiting delivery'], load: { processes: 8, cpuPercent: 25, memoryBytes: 100_000_000 } });
      h.core.bus.emit('thread.updated', { ...thread, progress: { turnId: 'observed-turn', phase: 'thinking', detail: null, at: Date.now() } });
    }
    await Bun.sleep(0);
    expect(changed).toEqual([]);
    for (const child of children) {
      const thread = { ...h.core.threads.require(child.thread.id), title: 'Updated task title' };
      h.core.journal.putThread(thread);
      h.core.bus.emit('thread.updated', thread);
    }
    await Bun.sleep(0);
    expect(changed.sort()).toEqual([threadId, ...children.map(child => child.thread.id)].sort());
    expect(h.core.delegation.get(threadId).agents.every(agent => agent.thread.title === 'Updated task title')).toBe(true);
  } finally { off(); }
});

test('rolled-back child notifications preserve team snapshots and stopped admission', async () => {
  scripted();
  const { h, threadId, spawn } = await setup();
  const childId = (await spawn('rollback-child', 'Check rollback notifications')).thread.id;
  await Bun.sleep(0);
  const child = h.core.threads.require(childId);
  const changed: string[] = [];
  const off = h.core.bus.onCommitted((name, payload) => {
    if (name === 'delegation.changed') changed.push((payload as { threadId: string }).threadId);
  });
  const admission = { id: 'turn_rollback_probe', threadId: childId } as Turn;
  const updated = { ...child, title: 'Committed after rollback' };
  try {
    expect(h.core.delegation.prepareTurn(admission)).toBe(true);
    // Abort after listeners have seen both events, rather than before the row write.
    expect(() => h.core.bus.afterCommit(() => h.core.journal.db.transaction(() => {
      h.core.journal.putThread(updated);
      h.core.bus.emit('thread.updated', updated);
      h.core.bus.emit('turn.finished', { ...admission, status: 'error', error: 'Aborted completion' });
      throw new Error('forced notification rollback');
    })())).toThrow('forced notification rollback');
    await Bun.sleep(0);
    expect(h.core.threads.require(childId).title).toBe(child.title);
    expect(changed).toEqual([]);
    expect(h.core.delegation.prepareTurn(admission)).toBe(true);

    // The same summary must still notify when it is subsequently committed.
    h.core.bus.afterCommit(() => h.core.journal.db.transaction(() => {
      h.core.journal.putThread(updated);
      h.core.bus.emit('thread.updated', updated);
    })());
    await Bun.sleep(0);
    expect(changed.sort()).toEqual([threadId, childId].sort());
    expect(h.core.delegation.get(threadId).agents[0]?.thread.title).toBe(updated.title);
  } finally { off(); }
});

test('a conversation without a team is offered workflows when the request names one, with no refusal and no set-up step', async () => {
  const runs = scripted();
  const { h, owner, threadId } = await setup({ enabled: false, profiles: [] });
  await owner.call('turns.start', { threadId, prompt: 'Run a dynamic workflow' });
  await waitFor(() => runs.has(threadId));
  const prompt = runs.get(threadId)!.ctx.prompt;
  for (const part of ['boite workflow help', 'boite workflow run', "this conversation's model"]) expect(prompt).toContain(part);
  for (const part of ['disabled', 'owner must', 'Do not substitute', 'Team settings']) expect(prompt).not.toContain(part);
  expect(h.core.delegation.instructions(threadId, 'Fix the parser', false)).toBe('');
  runs.get(threadId)!.finish();
});

test('native results survive message pagination and restart without using delegation turns or leaking to another thread', async () => {
  const runs = scripted();
  const { h, owner, threadId } = await setup({ enabled: false, profiles: [] });
  await owner.call('threads.subscribe', { threadId });
  await owner.call('turns.start', { threadId, prompt: 'Review' });
  await waitFor(() => runs.has(threadId));
  const run = runs.get(threadId)!;
  const changed = owner.next('delegation.changed', event => event.threadId === threadId);
  const unrelatedId = 'native-unrelated-stream';
  h.core.journal.putMessage({ id: unrelatedId, threadId: 'unrelated-thread', turnId: 'unrelated-turn', role: 'assistant', state: 'streaming', createdAt: Date.now(), parts: [] });
  h.core.journal.appendDelta('unrelated-thread', unrelatedId, 0, 'Unrelated streamed text');
  const id = run.ctx.emit.startMessage('assistant');
  run.ctx.emit.part(id, 0, { type: 'tool', toolId: 'native-review', name: 'Agent', input: { prompt: 'Review parsing', model: 'reviewer' }, output: null, status: 'running' });
  const rawParts = (messageId: string) => (h.core.journal.db.query('SELECT parts FROM messages WHERE id = ?').get(messageId) as { parts: string }).parts;
  // A Team read must show live tools without persisting this or other streams.
  expect(h.core.delegation.get(threadId).nativeAgents[0]).toMatchObject({ task: 'Review parsing', status: 'running' });
  expect(rawParts(id)).toBe('[]');
  expect(rawParts(unrelatedId)).toBe('[]');
  run.ctx.emit.part(id, 0, { type: 'tool', toolId: 'native-review', name: 'Agent', input: { prompt: 'Review parsing', model: 'reviewer' }, output: 'Checked', status: 'done' });
  expect(h.core.delegation.get(threadId).nativeAgents[0]).toMatchObject({ task: 'Review parsing', result: 'Checked', status: 'done' });
  expect(rawParts(id)).toBe('[]');
  expect(rawParts(unrelatedId)).toBe('[]');
  h.core.journal.persistMessages();
  expect(JSON.parse(rawParts(id))[0]).toMatchObject({ output: 'Checked', status: 'done' });
  expect(JSON.parse(rawParts(unrelatedId))).toEqual([{ type: 'text', text: 'Unrelated streamed text' }]);
  // A stale persisted tool cannot override its newer live update in the merge.
  run.ctx.emit.part(id, 0, { type: 'tool', toolId: 'native-review', name: 'Agent', input: { prompt: 'Review parsing', model: 'reviewer' }, output: null, status: 'running' });
  const live = h.core.delegation.get(threadId).nativeAgents;
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ status: 'running' });
  expect(live[0]?.result).toBeUndefined();
  expect(JSON.parse(rawParts(id))[0]).toMatchObject({ output: 'Checked', status: 'done' });
  run.ctx.emit.part(id, 0, { type: 'tool', toolId: 'native-review', name: 'Agent', input: { prompt: 'Review parsing', model: 'reviewer' }, output: 'Checked', status: 'done' });
  run.ctx.emit.complete(id, 'complete');
  await changed;
  // Populate the later page in one transaction while retaining the real message events.
  h.core.journal.db.transaction(() => {
    for (let index = 0; index < 220; index++) {
      const next = run.ctx.emit.startMessage('assistant');
      run.ctx.emit.part(next, 0, { type: 'text', text: `Later message ${index}` });
      run.ctx.emit.complete(next, 'complete');
    }
  })();
  const finished = owner.next('turn.finished', turn => turn.threadId === threadId);
  run.finish();
  await finished;
  const page = await owner.call('threads.get', { threadId });
  expect(page.messagesBefore).not.toBeNull();
  expect(page.messages.some(message => message.id === id)).toBe(false);
  const view = await owner.call('delegation.get', { threadId });
  expect(view.nativeAgents).toHaveLength(1);
  expect(view.nativeAgents[0]).toMatchObject({ task: 'Review parsing', result: 'Checked', status: 'done' });
  expect(view.turnsUsed).toBe(0);
  expect(view.usage.inputTokens).toBe(0);
  const other = await echoThread(h, owner, 'Other conversation');
  expect((await owner.call('delegation.get', { threadId: other.threadId })).nativeAgents).toEqual([]);
  await h.core.close();
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try { expect(restarted.delegation.get(threadId).nativeAgents).toEqual(view.nativeAgents); }
  finally { await restarted.close(); }
});

test('thirty delegated agents launch despite stored legacy team budgets', async () => {
  const runs = scripted(); const { h, threadId, config, spawn } = await setup();
  h.core.journal.setSetting(`delegation:${threadId}`, { ...config, maxAgents: 1, maxConcurrent: 1, maxTurns: 1, maxMinutes: 1 });
  const children = [];
  for (let index = 0; index < 30; index++) children.push(await spawn(`worker-${index}`));
  expect(h.core.delegation.get(threadId).agents).toHaveLength(30);
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(30);
  expect(children.every(child => runs.has(child.thread.id))).toBe(true);
  expect(h.core.scheduler.state().running).toHaveLength(30);
  expect(h.core.scheduler.state().queued).toEqual([]);
});

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

test('a fresh delegated session receives the configured brain instructions', async () => {
  const runs = scripted(); const { h, owner, spawn } = await setup();
  const path = join(h.dataDir, 'shared-brain');
  mkdirSync(path);
  writeFileSync(join(path, 'AGENTS.md'), 'Run parser checks before reporting completion.');
  await owner.call('brain.configure', { path, enabled: true, boiteGuide: true });
  const child = await spawn();
  expect(runs.get(child.thread.id)?.ctx.sessionId).toBeNull();
  expect(runs.get(child.thread.id)?.ctx.prompt).toContain('Run parser checks before reporting completion.');
  expect(runs.get(child.thread.id)?.ctx.prompt).toContain('boite where');
});

test('the parent learns dynamic workflows and coordination within a compact prompt', async () => {
  const runs = scripted(); const { h, owner, threadId } = await setup();
  await owner.call('brain.configure', { path: null, enabled: false, boiteGuide: true });
  h.core.settings.set({ asyncQuestions: true });
  h.core.coordination.configure(threadId, { mode: 'brief', resources: '', remote: false, paused: false });
  await owner.call('turns.start', { threadId, prompt: 'Review the parser' });
  const prompt = runs.get(threadId)!.ctx.prompt;
  for (const command of ['boite agents list', 'boite agents send', 'boite agents reply', 'boite delegate spawn', 'boite delegate send', 'boite workflow help', 'boite workflow check', 'boite workflow run', 'boite workflow extend', 'forEach', 'when']) expect(prompt).toContain(command);
  expect(Buffer.byteLength(prompt)).toBeLessThan(2600);
  runs.get(threadId)!.finish();
  await waitFor(() => h.core.threads.require(threadId).status === 'idle');
  await owner.call('turns.start', { threadId, prompt: 'Continue' });
  const resumed = runs.get(threadId)!.ctx;
  expect(resumed.prompt).not.toContain('boite where');
  expect(resumed.continuation!().prompt).toContain('boite where');
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
    await expect(owner.call('delegation.spawn', { threadId: other, profileId: 'worker', task: 'Off', requestId: 'off' })).rejects.toThrow('profileId: expected conversation');
    const letter = await worker.call('delegation.send', { threadId: child.thread.id, toThreadId: threadId, text: 'Need a path', requestId: 'ask' });
    expect(letter.from.threadId).toBe(child.thread.id);
    await expect(worker.call('delegation.send', { threadId: child.thread.id, toThreadId: threadId, text: 'Forged completion', requestId: 'result:fake' })).rejects.toThrow('reserved');
  } finally { agent.close(); worker.close(); }
});

test('a completed child can receive further turns without a team turn budget', async () => {
  const runs = scripted(); const { h, owner, threadId, spawn } = await setup();
  const one = await spawn('one'), two = await spawn('two');
  expect(h.core.threads.require(one.thread.id).status).toBe('running');
  expect(h.core.threads.require(two.thread.id).status).toBe('running');
  runs.get(one.thread.id)!.finish();
  await waitFor(() => h.core.threads.require(one.thread.id).status === 'idle');
  await owner.call('turns.start', { threadId: one.thread.id, prompt: 'More work' });
  expect(h.core.threads.require(one.thread.id).status).toBe('running');
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(4);
  expect(h.core.delegation.get(threadId).messages.some(m => m.text.includes('Tests passed'))).toBe(true);
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
  scripted(); const { h, owner, threadId, spawn, config } = await setup();
  const one = await spawn('one');
  holdAccountTurns(h);
  const two = await spawn('two');
  expect(two.thread.status).toBe('queued');
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

test('a conversation delegates to its own model with nothing configured, and no stop or restart pauses a team with nothing pending', async () => {
  const runs = scripted();
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    await owner.call('turns.start', { threadId, prompt: 'Hand the review to a subagent' });
    await waitFor(() => runs.has(threadId));
    expect(runs.get(threadId)!.ctx.prompt).toContain('boite delegate spawn');
    expect(h.core.delegation.instructions(threadId, 'Fix the parser', false)).toBe('');
    // A stopped turn of a conversation that delegated nothing leaves the team usable.
    await owner.call('turns.stop', { threadId });
    await waitFor(() => h.core.threads.require(threadId).status !== 'running');
    expect(h.core.delegation.config(threadId)).toEqual({ enabled: true, paused: false, profiles: [], anyModel: true });
    const child = await agent.call('delegation.spawn', { threadId, profileId: 'conversation', task: 'Review', requestId: 'plain' });
    const parent = h.core.threads.require(threadId);
    expect([child.thread.providerId, child.thread.accountId, child.thread.model]).toEqual([parent.providerId, parent.accountId, parent.model]);
    await waitFor(() => runs.has(child.thread.id));
    const first = runs.get(threadId);
    runs.get(child.thread.id)!.finish('Reviewed');
    // The result wakes the parent, which had nothing to switch on to receive it.
    await waitFor(() => runs.get(threadId) !== first);
    expect(runs.get(threadId)!.ctx.prompt).toContain('Reviewed');
    runs.get(threadId)!.finish();
    await waitFor(() => h.core.threads.require(threadId).status === 'idle');
    // The child finished and its result was delivered: stopping a later turn pauses nothing.
    await owner.call('turns.stop', { threadId });
    expect(h.core.delegation.config(threadId).paused).toBe(false);
    // A profile an owner already saved under the built-in id keeps its own route.
    const mine = { id: 'conversation', name: 'Mine', providerId: 'echo', accountId: parent.accountId, model: parent.model!, effort: 'low' };
    await owner.call('delegation.configure', { threadId, config: { enabled: true, paused: false, profiles: [mine] } });
    expect((await agent.call('delegation.spawn', { threadId, profileId: 'conversation', task: 'Again', requestId: 'mine' })).thread.effort).toBe('low');
    // That child is still working, so Stop all pauses; the owner's resume leaves nothing pending for a restart.
    await owner.call('delegation.stop', { threadId });
    expect(h.core.delegation.config(threadId).paused).toBe(true);
    await owner.call('delegation.configure', { threadId, config: { enabled: true, paused: false, profiles: [mine] } });
  } finally { agent.close(); }
  await h.core.close();
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try { expect(restarted.delegation.get(threadId).config.paused).toBe(false); }
  finally { await restarted.close(); }
});

test('archiving the parent stops its children and restart preserves the team while pausing spending', async () => {
  scripted(); const { h, owner, threadId, spawn, config } = await setup(); const child = await spawn();
  await owner.call('threads.archive', { threadId });
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
  expect(h.core.delegation.get(threadId).config.paused).toBe(true);
  await owner.call('threads.archive', { threadId, archived: false });
  await owner.call('delegation.configure', { threadId, config });
  // Mail the team still owes its parent is what a restart must not deliver by itself.
  await owner.call('delegation.send', { threadId, toThreadId: child.thread.id, text: 'One more file', requestId: 'more' });
  h.core.journal.db.query("UPDATE delegation_messages SET status = 'received' WHERE root_id = ?").run(threadId);
  expect((h.core.journal.db.query("SELECT count(*) AS n FROM delegation_messages WHERE root_id = ? AND status = 'received'").get(threadId) as { n: number }).n).toBeGreaterThan(0);
  await h.core.close();
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const view = restarted.delegation.get(threadId);
    expect(view.config.paused).toBe(true);
    expect(view.agents[0]?.thread.parentThreadId).toBe(threadId);
    expect(view.turnsUsed).toBe(2);
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
  // The current form: the brief alone, with a model and a level by flag.
  expect(await call(['delegate', 'models'])).toContain('echo/echo "Echo" effort=low|high (default high) [this conversation]');
  const free = await call(['delegate', 'spawn', 'Read', 'the', 'parser', '--model', 'echo/echo', '--effort', 'low', '--title', 'Parser read']);
  expect(free).toMatch(/^agent: thr_\S+\nmodel: echo\/echo effort=low\nstatus: \w+\n/);
  const list = await call(['delegate', 'list']);
  expect(list.split('\n')[0]).toBe('subagents: on; 2 running, 0 done, 0 failed, 0 stopped');
  expect(list).toMatch(/thr_\S+ running \d+s echo\/echo effort=low "Parser read"/);
  expect(list).toContain('Results arrive as messages');
  expect(await call(['delegate', 'stop'])).toContain('stopped: 2');
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

test('ordinary threads leave delegation unset on stop/archive; stopping an enabled parent pauses its team', async () => {
  scripted(); const { h, owner, threadId, spawn } = await setup();
  const ordinary = (await echoThread(h, owner, 'No team')).threadId;
  h.core.threads.startTurn(ordinary, 'Work alone');
  expect(await owner.call('turns.stop', { threadId: ordinary })).toEqual({ stopped: true });
  expect(h.core.journal.getSetting(`delegation:${ordinary}`)).toBeUndefined();
  h.core.threads.archive(ordinary, true);
  expect(h.core.journal.getSetting(`delegation:${ordinary}`)).toBeUndefined();
  h.core.threads.startTurn(threadId, 'Coordinate');
  const child = await spawn();
  expect(await owner.call('turns.stop', { threadId })).toEqual({ stopped: true });
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
  expect(h.core.delegation.get(threadId).config.paused).toBe(true);
});

test('account login admission queues a nonblocking spawn, then its result wakes the parent', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup();
  h.core.threads.startTurn(threadId, 'Coordinate');
  const parentRun = runs.get(threadId)!;
  const release = holdAccountTurns(h);
  const child = await spawn();
  expect(child.thread.status).toBe('queued');
  expect(runs.has(child.thread.id)).toBe(false);
  parentRun.finish('Delegated, awaiting result.');
  release();
  await waitFor(() => runs.has(child.thread.id));
  runs.get(child.thread.id)!.finish('Result ready');
  await waitFor(() => runs.get(threadId) !== parentRun, 5000);
  expect(runs.get(threadId)!.ctx.prompt).toContain('Result ready');
});

test('the regular Stop command reports cancellation of a queued parent wake', async () => {
  const runs = scripted(); const { h, owner, threadId, spawn } = await setup();
  const child = await spawn();
  const blocker = (await echoThread(h, owner, 'Other work')).threadId;
  h.core.threads.startTurn(blocker, 'Keep existing work running');
  holdAccountTurns(h);
  runs.get(child.thread.id)!.finish('Result ready');
  await waitFor(() => h.core.threads.require(threadId).status === 'queued', 5000);
  expect(await owner.call('turns.stop', { threadId })).toEqual({ stopped: true });
  expect(h.core.journal.listTurns(threadId)[0]?.status).toBe('stopped');
  expect(h.core.delegation.get(threadId).config.paused).toBe(true);
  expect(h.core.threads.require(blocker).status).toBe('running');
});

test('stopping an idle child sweeps what its released agent left running', async () => {
  const runs = scripted(); const { h, owner, threadId, spawn } = await setup();
  const child = await spawn();
  runs.get(child.thread.id)!.finish();
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
  const swept: string[] = [];
  h.core.procs.sweepSoon = (id: string): void => { swept.push(id); };
  await owner.call('delegation.stop', { threadId, agentId: child.thread.id });
  expect(swept).toEqual([child.thread.id]);
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

test('a legacy deadline does not stop a child and project removal deletes delegation records', async () => {
  scripted(); const { h, owner, threadId, spawn } = await setup(); const child = await spawn();
  h.core.journal.setSetting(`delegation:${threadId}`, { ...h.core.delegation.config(threadId), maxMinutes: 1 });
  const now = Date.now(); const clock = spyOn(Date, 'now').mockReturnValue(now + 61_000);
  try { await Bun.sleep(1100); expect(h.core.threads.require(child.thread.id).status).toBe('running'); }
  finally { clock.mockRestore(); }
  await owner.call('projects.remove', { projectId: h.core.threads.require(threadId).projectId! });
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM delegated_agents').get()).toEqual({ n: 0 });
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM delegation_messages').get()).toEqual({ n: 0 });
});

test('results held while the parent waits join its next manual prompt without steering or hooks', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup();
  const child = await spawn();
  h.core.journal.putThread({ ...h.core.threads.require(threadId), status: 'waiting' });
  runs.get(child.thread.id)!.finish('Completed boundary review');
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
  expect(h.core.delegation.get(threadId).messages[0]?.origin).toBe('result');
  h.core.journal.putThread({ ...h.core.threads.require(threadId), status: 'idle' });
  h.core.threads.startTurn(threadId, 'Continue with the result');
  expect(runs.get(threadId)!.ctx.prompt).toContain('Completed boundary review');
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(1);
});

test('a turn retried on a fresh session after a lost resume still carries the held answers and child results', async () => {
  const calls: TurnContext[] = [];
  let lose = false;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    calls.push(ctx);
    if (lose && ctx.sessionId !== null) {
      // The agent refused the resume before the prompt reached any model.
      return { done: Promise.resolve<TurnResult>({ status: 'error', sessionId: ctx.sessionId, usage: null, error: 'no conversation found', sessionLost: true }), stop() {} };
    }
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: ctx.thread.parentThreadId ? 'Completed boundary review' : 'Planned.' });
    ctx.emit.complete(id, 'complete');
    return { done: Promise.resolve<TurnResult>({ status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null }), stop() {} };
  } }));
  const { h, threadId, spawn } = await setup();
  h.core.threads.startTurn(threadId, 'Plan the work');
  await waitFor(() => h.core.threads.require(threadId).sessionId === `session:${threadId}` && h.core.threads.require(threadId).status === 'idle');
  h.core.journal.putThread({ ...h.core.threads.require(threadId), status: 'waiting' });
  const child = await spawn();
  await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle');
  // The parent is awaiting input, so the result stays in its inbox for the next prompt.
  await waitFor(() => h.core.delegation.get(threadId).messages.some(m => m.origin === 'result' && m.status === 'received'));
  h.core.threads.deferred.deferredAnswers.set(threadId, ['Held async answer']);

  lose = true;
  calls.length = 0;
  h.core.journal.putThread({ ...h.core.threads.require(threadId), status: 'idle' });
  const turn = h.core.threads.startTurn(threadId, 'Continue with the result');
  await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done', 5000);
  expect(calls.map(ctx => ctx.sessionId)).toEqual([`session:${threadId}`, null]);
  for (const ctx of calls) {
    expect(ctx.prompt).toContain('Completed boundary review');
    expect(ctx.prompt).toContain('Held async answer');
  }
  expect(h.core.delegation.get(threadId).messages.find(m => m.origin === 'result')?.status).toBe('delivered');
  expect(h.core.threads.require(threadId).sessionGeneration).toBe(1);
});

test('an automatic parent wake survives a stored legacy deadline', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup();
  const child = await spawn();
  runs.get(child.thread.id)!.finish('Result to integrate');
  await waitFor(() => runs.has(threadId), 4000);
  h.core.journal.setSetting(`delegation:${threadId}`, { ...h.core.delegation.config(threadId), maxMinutes: 1 });
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try { await Bun.sleep(1100); expect(h.core.threads.require(threadId).status).toBe('running'); }
  finally { clock.mockRestore(); }
  expect(h.core.delegation.get(threadId).config.paused).toBe(false);
  expect(h.core.journal.listTurns(threadId)[0]?.status).toBe('running');
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

test('a finished child wakes an idle parent at once, without waiting for the tick', async () => {
  const runs = scripted(); const { h, threadId, spawn } = await setup();
  const child = await spawn();
  runs.get(child.thread.id)!.finish();
  // The tick runs every second: 100 ms leaves it a 10 % chance to be the one that delivered.
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(h.core.journal.listTurns(threadId).map(turn => turn.execution?.operation)).toEqual(['delegation']);
  expect(runs.get(threadId)?.ctx.prompt).toContain('Checked src/example.ts');
});

test('an agent picks any installed model and reasoning level for a child, never a fast tier, unless the owner holds it to the profiles', async () => {
  const running = scripted();
  const { h, owner, threadId } = await setup();
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../src/providers/shipped/echo.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(h.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(h.dataDir, 'providers', 'twin.json'), JSON.stringify({ ...shipped, id: 'twin', name: 'Twin', shortName: 'Twin', models: [
    { id: 'echo', name: 'Twin echo' },
    { id: 'deep-thinker', name: 'Deep thinker', effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'max', label: 'Max' }], default: 'low' } },
  ] }));
  expect((await owner.call('providers.reload', {})).rejected).toEqual([]);
  h.core.accounts.ensureDefaults();
  h.core.journal.putThread({ ...h.core.threads.require(threadId), speed: 'fast' });
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const models = await agent.call('delegation.models', { threadId });
    expect(models.anyModel).toBe(true);
    expect(models.choices.map(c => `${c.providerId}/${c.model}`)).toEqual(expect.arrayContaining(['echo/echo', 'twin/echo', 'twin/deep-thinker']));
    expect(models.choices.find(c => c.providerId === 'echo')?.current).toBe(true);

    const deep = await agent.call('delegation.spawn', { threadId, model: 'deep', effort: 'max', task: 'Think hard', requestId: 'deep' });
    expect([deep.thread.providerId, deep.thread.model, deep.thread.effort, deep.thread.speed ?? null]).toEqual(['twin', 'deep-thinker', 'max', null]);
    expect(deep.thread.accountId).toBe(h.core.accounts.list().find(a => a.providerId === 'twin')!.id);
    // A bare id two harnesses share resolves to the parent's own; a full id names the other one.
    expect((await agent.call('delegation.spawn', { threadId, model: 'echo', task: 'Same harness', requestId: 'same' })).thread.providerId).toBe('echo');
    expect((await agent.call('delegation.spawn', { threadId, model: 'twin/echo', task: 'Other harness', requestId: 'other' })).thread.providerId).toBe('twin');
    await expect(agent.call('delegation.spawn', { threadId, model: 'twin/deep-thinker', effort: 'ultra', task: 'Bad level', requestId: 'bad-level' })).rejects.toThrow('reasoning effort');
    await expect(agent.call('delegation.spawn', { threadId, model: 'nothing-like-this', task: 'Missing', requestId: 'missing' })).rejects.toThrow('boite delegate models');
    await waitFor(() => running.has(deep.thread.id));

    await owner.call('delegation.configure', { threadId, config: { ...h.core.delegation.config(threadId), anyModel: false } });
    await expect(agent.call('delegation.spawn', { threadId, model: 'twin/deep-thinker', task: 'Held', requestId: 'held' })).rejects.toThrow('limited subagents');
    expect((await agent.call('delegation.spawn', { threadId, model: 'echo/echo', effort: 'low', task: 'Own model', requestId: 'own' })).thread.effort).toBe('low');
    expect((await agent.call('delegation.models', { threadId })).anyModel).toBe(false);
  } finally { agent.close(); }
});
