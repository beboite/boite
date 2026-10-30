import { BACKGROUND_WAKE_GRACE_MS } from '@boite/contracts';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowPlan, WorkflowRun } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

/* Workflow steps with `machine`: a run here, one of its steps a subagent on another machine of the group. */

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** Each turn answers `reply(prompt)`; null holds it until stopped. Every prompt is kept by thread. */
function scripted(reply: (prompt: string, ctx: TurnContext) => string | null) {
  const prompts = new Map<string, string[]>();
  const held = new Set<string>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const done: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    const text = reply(ctx.prompt, ctx);
    if (text !== null) {
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text });
      ctx.emit.complete(id, 'complete');
      return { done: Promise.resolve(done), stop() {} };
    }
    held.add(ctx.thread.id);
    const finished = Promise.withResolvers<TurnResult>();
    return { done: finished.promise, stop() { held.delete(ctx.thread.id); finished.resolve({ status: 'stopped', sessionId: null, usage: null }); } };
  } }));
  return { prompts, held };
}

/** A conversation on `desk`, and `pc` in the same group with a project Notes. A data directory given is kept for a restart. */
async function setup(allow = true, dirs: { desk?: string; pc?: string } = {}) {
  const desk = await startTestCore(dirs.desk === undefined ? {} : { dataDir: dirs.desk });
  const pc = await startTestCore(dirs.pc === undefined ? {} : { dataDir: dirs.pc });
  cores.push(desk, pc);
  const owner = await desk.connect();
  const pcOwner = await pc.connect();
  await desk.core.group.create('Home');
  await pc.core.group.join((await desk.core.group.invite()).invite);
  const pcId = pc.core.coordination.card().coreId, deskId = desk.core.coordination.card().coreId;
  await waitFor(() => desk.core.group.peers().some(peer => peer.coreId === pcId) && pc.core.group.peers().some(peer => peer.coreId === deskId));
  const { threadId } = await echoThread(desk, owner, 'Family helper');
  const notesPath = join(pc.dataDir, 'notes');
  mkdirSync(notesPath, { recursive: true });
  const notes = await pcOwner.call('projects.add', { path: notesPath, name: 'Notes' });
  if (allow) await pc.core.settings.set({ groupThreads: true });
  const onPc = () => pc.core.journal.listThreads().filter(thread => thread.projectId === notes.id);
  const run = (runId: string): WorkflowRun => desk.core.workflows.get(threadId, runId);
  return { desk, pc, owner, threadId, pcId, deskId, machine: pcId.slice(0, 8), notesPath, onPc, run };
}

/** A data directory a core restarts on, removed after the test. */
function restartable(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boite-workflow-machine-'));
  restores.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const JSON_BLOCK = (value: unknown) => `Here it is.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

test('a step on another machine runs there after a step here, and its JSON output feeds the run', async () => {
  const { prompts } = scripted(prompt => {
    if (prompt.includes('step scan')) return JSON_BLOCK({ files: ['a.ts', 'b.ts'] });
    // The first answer there has no JSON: the run asks that subagent once more, as it asks a step here.
    // The second puts it past the first page, after characters of two UTF-16 units: pages count code points.
    if (prompt.includes('does not match this workflow step')) return `${'🦊'.repeat(1_000)}${'x'.repeat(13_990)}\n${JSON_BLOCK({ count: 2 })}`;
    if (prompt.includes('step count')) return 'Two files.';
    return 'Summary read.';
  });
  const { desk, pc, owner, threadId, pcId, machine, onPc, run } = await setup();
  const plan: WorkflowPlan = { name: 'Across', steps: [
    { id: 'scan', task: 'List the files.', output: { files: ['string'] } },
    { id: 'count', machine, project: 'notes', task: 'Count these files: {{scan.files}}', output: { count: 'number' } },
  ] };
  expect((await owner.call('workflows.check', { threadId, plan })).levels).toEqual([['scan'], ['count']]);
  const started = await owner.call('workflows.start', { threadId, requestId: 'across-1', plan });
  await waitFor(() => run(started.id).status === 'done', 10_000);

  const [child] = onPc();
  expect(child).toBeDefined();
  const count = run(started.id).nodes[1]!.instances[0]!;
  expect(count).toMatchObject({ status: 'done', output: { count: 2 }, threadId: null, providerId: 'echo' });
  expect(count.machine).toMatchObject({ name: pc.core.coordination.identity().name, coreId: pcId, childId: child!.id, corrections: 1 });
  // It ran there, on what the step before it returned here.
  const first = prompts.get(child!.id)![0]!;
  expect(first).toContain('step count');
  expect(first).toContain('a.ts');
  expect(first).not.toContain('boite workflow output');
  expect(desk.core.journal.getThread(child!.id)).toBeNull();
  // Its answer went to the run, never to the conversation as mail, and the subagent list does not show it.
  expect(desk.core.journal.db.query("SELECT count(*) AS n FROM delegation_messages WHERE root_id = ? AND request_id GLOB 'result:*'").get(threadId)).toEqual({ n: 0 });
  expect((await owner.call('delegation.get', { threadId })).agents).toHaveLength(0);
  await waitFor(() => (prompts.get(threadId) ?? []).some(prompt => prompt.includes('Boite workflow done') && prompt.includes('count')));
});

test('a plan naming a machine not in the group is refused before it starts; one whose owner keeps groupThreads off fails the step with the setting to propose', async () => {
  scripted(() => 'ok');
  const { owner, threadId, machine, onPc, run } = await setup(false);
  const nowhere: WorkflowPlan = { name: 'Nowhere', steps: [{ id: 'far', machine: 'nowhere', task: 'Read.' }] };
  const checked = await thrown(owner.call('workflows.check', { threadId, plan: nowhere }));
  expect(checked).toThrow('steps[0].machine: no machine nowhere in this group; the others are');
  expect(await thrown(owner.call('workflows.start', { threadId, requestId: 'nowhere-1', plan: nowhere }))).toThrow('steps[0].machine: no machine nowhere in this group');
  expect(await owner.call('workflows.list', { threadId })).toHaveLength(0);

  const off = await owner.call('workflows.start', { threadId, requestId: 'off-1', plan: { name: 'Off', steps: [{ id: 'far', machine, project: 'notes', task: 'Read.' }] } });
  await waitFor(() => run(off.id).status === 'failed');
  expect(run(off.id).nodes[0]!.instances[0]!.error).toContain(`boite settings request groupThreads true --machine ${machine} --why`);
  expect(onPc()).toHaveLength(0);
});

test('a remote child whose first turn cannot start fails the step instead of waiting for a turn', async () => {
  scripted(() => 'ok');
  const { pc, owner, threadId, machine, onPc, run } = await setup();
  const start = spyOn(pc.core.threads, 'startTurn').mockImplementation(() => { throw new Error('first turn refused'); });
  restores.push(() => start.mockRestore());
  const started = await owner.call('workflows.start', { threadId, requestId: 'failed-first-turn', plan: { name: 'Refused', steps: [{ id: 'read', machine, project: 'notes', task: 'Read the notes.' }] } });
  await waitFor(() => run(started.id).status === 'failed', 1_000);
  expect(onPc()).toHaveLength(1);
  expect(onPc()[0]!.status).toBe('error');
  expect(run(started.id).nodes[0]!.instances[0]).toMatchObject({ status: 'failed', machine: { childId: onPc()[0]!.id } });
});

for (const restart of [false, true]) test(`stopping the run${restart ? ' after a caller restart' : ''} stops its step on the other machine`, async () => {
  const { held } = scripted(prompt => (prompt.includes('step slow') ? null : 'ok'));
  const deskDir = restartable();
  const { desk, pc, owner, threadId, pcId, machine, onPc, run } = await setup(true, { desk: deskDir });
  const started = await owner.call('workflows.start', { threadId, requestId: 'stop-1', plan: { name: 'Stop', steps: [{ id: 'slow', machine, project: 'notes', task: 'Read every page.' }] } });
  await waitFor(() => onPc().length === 1 && held.has(onPc()[0]!.id));
  const childId = onPc()[0]!.id;
  await waitFor(() => run(started.id).nodes[0]!.instances[0]!.machine?.childId === childId);

  let caller = desk, client = owner;
  if (restart) {
    const port = Number(new URL(desk.url).port);
    await desk.stop();
    caller = await startTestCore({ dataDir: deskDir, port });
    cores.push(caller);
    client = await caller.connect();
    expect(caller.core.workflows.get(threadId, started.id)).toMatchObject({ status: 'paused', nodes: [{ instances: [{ status: 'waiting' }] }] });
    expect(held.has(childId)).toBe(true);
  }

  await client.call('workflows.control', { threadId, runId: started.id, action: 'stop' });
  expect(caller.core.workflows.get(threadId, started.id)).toMatchObject({ status: 'stopped', nodes: [{ instances: [{ status: 'stopped' }] }] });
  await caller.core.delegation.remote.flush(pcId);
  await waitFor(() => !held.has(childId) && pc.core.threads.require(childId).status !== 'running', 1_000);
  expect(pc.core.journal.listTurns(childId).at(-1)?.status).toBe('stopped');
});

test('a run stopped before the start answer came stops its subagent there once a report names it', async () => {
  const { held } = scripted(prompt => (prompt.includes('step slow') ? null : 'ok'));
  const { desk, pc, owner, threadId, pcId, deskId, machine, onPc, run } = await setup();
  // The start reaches that machine and its answer is lost; that machine's reports do not come through yet either.
  const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = (async (peer, operation, payload) => {
    const answer = await request(peer, operation, payload);
    if (operation === 'delegation.start') { arrived.resolve(); await release.promise; throw new Error('the answer was lost'); }
    return answer;
  }) as typeof desk.core.coordination.request;
  let away = true;
  const report = pc.core.coordination.request.bind(pc.core.coordination);
  pc.core.coordination.request = ((peer, operation, payload) => (operation === 'delegation.report' && away
    ? Promise.reject(new Error('offline')) : report(peer, operation, payload))) as typeof pc.core.coordination.request;
  const started = await owner.call('workflows.start', { threadId, requestId: 'lost-1', plan: { name: 'Lost', steps: [{ id: 'slow', machine, project: 'notes', task: 'Read.' }] } });
  await arrived.promise;
  const childId = onPc()[0]!.id;
  await waitFor(() => held.has(childId));
  expect(run(started.id).nodes[0]!.instances[0]!.machine?.childId).toBeNull();

  await owner.call('workflows.control', { threadId, runId: started.id, action: 'stop' });
  release.resolve();
  away = false;
  await pc.core.delegation.remote.flush(deskId);
  await desk.core.delegation.remote.flush(pcId);
  // Before, nothing knew that subagent here when the run stopped, and it worked on there.
  await waitFor(() => !held.has(childId) && pc.core.journal.listTurns(childId).at(-1)?.status === 'stopped');
  expect(run(started.id).status).toBe('stopped');
});

test('a restart of the other machine keeps its step at work, and the turn it resumes settles the step', async () => {
  const { held, prompts } = scripted(prompt => (prompt.startsWith('Boite restarted') ? 'Read after the restart.' : prompt.includes('step slow') ? null : 'ok'));
  const pcDir = restartable();
  const { desk, pc, owner, threadId, deskId, machine, onPc, run } = await setup(true, { pc: pcDir });
  const started = await owner.call('workflows.start', { threadId, requestId: 'member-restart-1', plan: { name: 'Restart', steps: [{ id: 'slow', machine, project: 'notes', task: 'Read.' }] } });
  await waitFor(() => onPc().length === 1 && held.has(onPc()[0]!.id));
  const childId = onPc()[0]!.id;
  await waitFor(() => run(started.id).nodes[0]!.instances[0]!.machine?.childId === childId);

  await waitFor(() => pc.core.delegation.remote.waiting(deskId).reports === 0);
  const sending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const request = pc.core.coordination.request.bind(pc.core.coordination);
  let delay = true;
  pc.core.coordination.request = (async (peer, operation, payload) => {
    if (operation === 'delegation.report' && delay) { delay = false; sending.resolve(); await release.promise; }
    return request(peer, operation, payload);
  }) as typeof pc.core.coordination.request;
  // A running-state report is already in flight when the handoff stops the
  // turn. Another flush cannot overtake it with the stopped-state report.
  pc.core.delegation.remote.restate();
  const reporting = pc.core.delegation.remote.flush(deskId);
  await sending.promise;
  try {
    await pc.core.threads.handoff.begin(0);
    await pc.core.delegation.remote.flush(deskId);
  } finally { release.resolve(); await reporting; }
  const state = () => desk.core.delegation.remote.record(threadId, run(started.id).nodes[0]!.instances[0]!.machine!.requestId)?.state;
  // flush is best effort while an earlier report is in flight. Wait for the
  // stopped-state report to arrive before checking the receiving machine.
  await waitFor(() => state()?.lastTurn?.status === 'stopped' && state()?.restarting === true);
  expect(state()).toMatchObject({ lastTurn: { status: 'stopped' }, restarting: true });
  expect(run(started.id)).toMatchObject({ status: 'running', nodes: [{ instances: [{ status: 'running' }] }] });
  const port = Number(new URL(pc.url).port);
  await pc.stop();
  cores.push(await startTestCore({ dataDir: pcDir, port }));

  await waitFor(() => run(started.id).status === 'done', 10_000);
  expect(prompts.get(childId)!.at(-1)).toStartWith('Boite restarted');
  expect(run(started.id).nodes[0]!.instances[0]).toMatchObject({ status: 'done', result: 'Read after the restart.' });
});

test('a restart here sends again an output correction decided before that machine took it, and its answer settles the step once', async () => {
  const { prompts } = scripted(prompt => (prompt.includes('does not match this workflow step') ? JSON_BLOCK({ count: 2 }) : prompt.includes('step count') ? 'Two files.' : 'ok'));
  const deskDir = restartable();
  const { desk, owner, threadId, machine, onPc, run } = await setup(true, { desk: deskDir });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  desk.core.delegation.remote.send = (async () => { entered.resolve(); await release.promise; throw new Error('the core stopped before sending'); }) as typeof desk.core.delegation.remote.send;
  const started = await owner.call('workflows.start', { threadId, requestId: 'correction-1', plan: { name: 'Correction', steps: [{ id: 'count', machine, project: 'notes', task: 'Count.', output: { count: 'number' } }] } });
  await entered.promise;
  const childId = onPc()[0]!.id;
  expect(run(started.id).nodes[0]!.instances[0]!.machine).toMatchObject({ corrections: 1, correction: { requestId: expect.stringContaining(':output-1') } });
  desk.core.workflows.beginClose();
  release.resolve();
  const port = Number(new URL(desk.url).port);
  await desk.stop();

  const next = await startTestCore({ dataDir: deskDir, port });
  cores.push(next);
  await (await next.connect()).call('workflows.control', { threadId, runId: started.id, action: 'resume' });
  const settled = () => next.core.workflows.get(threadId, started.id);
  // Before, the judged turn was all the step had, and nothing asked that subagent again.
  await waitFor(() => settled().status === 'done', 10_000);
  expect(settled().nodes[0]!.instances[0]).toMatchObject({ status: 'done', output: { count: 2 }, machine: { corrections: 1 } });
  expect(settled().nodes[0]!.instances[0]!.machine!.correction).toBeUndefined();
  expect(prompts.get(childId)).toHaveLength(2);
});

test('a step on another machine in a worktree of its own ends once that worktree is kept there, and the summary names its branch', async () => {
  const { prompts } = scripted((prompt, ctx) => {
    if (!prompt.includes('step edit')) return 'ok';
    writeFileSync(join(ctx.thread.cwd, 'fix.txt'), 'the change\n');
    return 'Changed fix.txt.';
  });
  const { pc, owner, threadId, machine, notesPath, onPc, run } = await setup();
  for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'fixture init']]) {
    const done = Bun.spawnSync({ cmd: ['git', ...args], cwd: notesPath, env: { ...process.env, GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid', GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid' }, stdout: 'pipe', stderr: 'pipe' });
    if (!done.success) throw new Error(done.stderr.toString());
  }
  const started = await owner.call('workflows.start', { threadId, requestId: 'worktree-1', plan: { name: 'Worktree', steps: [{ id: 'edit', machine, project: 'notes', task: 'Edit one file.', worktree: true }] } });
  await waitFor(() => run(started.id).status === 'done', 10_000);
  const kept = pc.core.delegation.worktrees.get(onPc()[0]!.id)!;
  // Before, the step ended on the turn, with no worktree, so the summary had no branch to merge.
  expect(run(started.id).nodes[0]!.instances[0]!.worktree).toMatchObject({ branch: kept.branch, state: 'kept' });
  await waitFor(() => (prompts.get(threadId) ?? []).some(prompt => prompt.includes('Boite workflow done') && prompt.includes(kept.branch)));
});

test('a step with both machine and compute is invalid', async () => {
  scripted(() => 'ok');
  const { owner, threadId, machine } = await setup();
  const compute = { sharedProjectId: 'shared-1', host: { ownerCoreId: 'a'.repeat(64), coreId: 'b'.repeat(64), projectId: 'p1' }, profileId: 'default', baseCommit: 'c'.repeat(40) };
  const both = await thrown(owner.call('workflows.check', { threadId, plan: { name: 'Both', steps: [{ id: 'far', machine, compute, task: 'Read.' }] } }));
  expect(both).toThrow('steps[0].machine: a step runs on another machine of the group or on a shared-project host, not both');
});

for (const ending of ['completed', 'error', 'refused'] as const) test(`a remote step waits past its checkpoint when background work ends ${ending}`, async () => {
  const runs = new Map<string, { ctx: TurnContext; finish: (text: string) => void }>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    const done = Promise.withResolvers<TurnResult>();
    const finish = (text: string) => {
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text });
      ctx.emit.complete(id, 'complete');
      done.resolve({ status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null });
    };
    if (ctx.prompt.includes('step watch') || runs.has(ctx.thread.id)) runs.set(ctx.thread.id, { ctx, finish });
    else finish('Summary read.');
    return { done: done.promise, stop() { done.resolve({ status: 'stopped', sessionId: null, usage: null }); } };
  } }));
  const { desk, pc, owner, threadId, machine, onPc, run } = await setup();
  const started = await owner.call('workflows.start', { threadId, requestId: `background-${ending}`, plan: {
    name: 'Remote background', steps: [{ id: 'watch', machine, project: 'notes', task: 'Watch CI.' }],
  } });
  await waitFor(() => onPc().some(child => runs.has(child.id)));
  const childId = onPc()[0]!.id, first = runs.get(childId)!;
  const step = () => run(started.id).nodes[0]!.instances[0]!;
  first.ctx.background!([{ id: 'ci', kind: 'monitor', description: 'Pending CI', toolId: null, startedAt: Date.now() }]);
  first.finish('Checkpoint: waiting for CI.');
  await waitFor(() => pc.core.threads.require(childId).status === 'idle');
  expect(pc.core.threads.get(childId).backgroundWait).toMatchObject({ state: 'waiting' });
  await waitFor(() => desk.core.delegation.remote.record(threadId, step().machine!.requestId)?.state?.thread.backgroundWait?.state === 'waiting');
  expect(step()).toMatchObject({ status: 'running', result: null });
  if (ending === 'refused') {
    const start = spyOn(pc.core.threads, 'startTurn').mockImplementation(() => { throw new Error('provider disabled'); });
    restores.push(() => start.mockRestore());
  }
  const now = Date.now.bind(Date);
  const checkpointAt = pc.core.journal.getTurn(first.ctx.turn.id)!.finishedAt!;
  // Completion is causally after the checkpoint even when the clock has not advanced.
  const clock = spyOn(Date, 'now').mockReturnValue(checkpointAt);
  restores.push(() => clock.mockRestore());
  first.ctx.backgroundFinished!('ci', ending === 'error' ? 'error' : 'completed');
  expect(pc.core.threads.agentState.backgroundHistory.list(childId)[0]!.finishedAt).toBe(checkpointAt);
  expect(pc.core.threads.get(childId).backgroundWait).toMatchObject({ state: 'waiting' });
  clock.mockImplementation(() => now() + BACKGROUND_WAKE_GRACE_MS + 1000);
  if (ending !== 'completed') {
    await waitFor(() => ['failed', 'done'].includes(run(started.id).status));
    clock.mockRestore();
    expect(run(started.id).status).toBe('failed');
    expect(step().result).toBeNull();
    expect(step().error).toContain('checkpoint');
    if (ending === 'refused') expect(step().error).toContain('provider disabled');
    return;
  }
  try {
    await waitFor(() => runs.get(childId) !== first, 5000);
  } catch (error) {
    try {
      console.error('Background final wake timeout', {
        now: Date.now(),
        checkpoint: pc.core.journal.getTurn(first.ctx.turn.id),
        thread: pc.core.threads.get(childId),
        history: pc.core.threads.agentState.backgroundHistory.list(childId),
        run: run(started.id),
        remote: desk.core.delegation.remote.record(threadId, step().machine!.requestId),
        logs: await pc.core.logs.query({ limit: 40, minLevel: 'debug' }),
      });
    } catch (diagnosticError) { console.error('Background final wake diagnostics failed', diagnosticError); }
    throw error;
  }
  clock.mockRestore();
  expect(step()).toMatchObject({ status: 'running', result: null });
  expect(runs.get(childId)!.ctx.prompt).toContain('give your final result now');
  runs.get(childId)!.finish('Final result: CI passed.');
  await waitFor(() => run(started.id).status === 'done');
  expect(step().result).toBe('Final result: CI passed.');
}, 20_000);
