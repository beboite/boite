import { afterEach, expect, spyOn, test } from 'bun:test';
import { BACKGROUND_WAKE_GRACE_MS, DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { DelegationConfig, WorkflowPlan } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** Every turn stays running until the test finishes it, as `delegation.test.ts` drives children. */
function scripted() {
  const runs = new Map<string, { ctx: TurnContext; finish: (text?: string, status?: TurnResult['status']) => void }>();
  const prompts: { threadId: string; prompt: string }[] = [];
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    prompts.push({ threadId: ctx.thread.id, prompt: ctx.prompt });
    let resolve!: (value: TurnResult) => void;
    const done = new Promise<TurnResult>(r => { resolve = r; });
    const finish = (text = 'ok', status: TurnResult['status'] = 'done') => {
      if (text) {
        const id = ctx.emit.startMessage('assistant');
        ctx.emit.part(id, 0, { type: 'text', text });
        ctx.emit.complete(id, 'complete');
      }
      resolve({ status, sessionId: `session:${ctx.thread.id}`, usage: null });
    };
    runs.set(ctx.thread.id, { ctx, finish });
    return { done, stop() { finish('', 'stopped'); } };
  } }));
  return { runs, prompts };
}

async function parent() {
  const driver = scripted();
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const thread = h.core.threads.require(threadId);
  const config: DelegationConfig = { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [
    { id: 'fast', name: 'Fast', providerId: 'echo', accountId: thread.accountId, model: thread.model!, effort: null },
  ] };
  await owner.call('delegation.configure', { threadId, config });
  /** The child starts CI in the background and ends its turn on that checkpoint. */
  const checkpoint = async (childId: string) => {
    await waitFor(() => driver.runs.has(childId));
    const first = driver.runs.get(childId)!;
    first.ctx.background!([{ id: 'ci-1', kind: 'monitor', description: 'Pending CI', toolId: null, startedAt: Date.now() }]);
    first.finish('Checkpoint: waiting for CI.');
    await waitFor(() => h.core.threads.require(childId).status === 'idle');
    return first;
  };
  return { ...driver, h, owner, threadId, checkpoint };
}

async function setup() {
  const base = await parent();
  const { h, owner, threadId } = base;
  const run = await owner.call('workflows.start', { threadId, requestId: 'ci', plan: PLAN });
  const step = () => h.core.workflows.get(threadId, run.id).nodes[0]!.instances[0]!;
  await waitFor(() => !!step()?.threadId);
  const childId = step().threadId!;
  return { ...base, run, step, childId, first: await base.checkpoint(childId) };
}

const PLAN: WorkflowPlan = { name: 'Watch CI', steps: [
  { id: 'watch', profile: 'fast', task: 'Watch CI.' },
  { id: 'report', profile: 'fast', after: ['watch'], task: 'Report on {{watch}}' },
] };

test('a step that ends its turn on background work stays running, and its final answer is the one the run carries on', async () => {
  const { h, threadId, run, step, childId, first, runs, prompts } = await setup();
  // Checkpoint, not a result: nothing depends on it yet.
  await new Promise(resolve => setTimeout(resolve, 100));
  const waiting = h.core.workflows.get(threadId, run.id);
  expect(waiting.status).toBe('running');
  expect(step()).toMatchObject({ status: 'running', result: null });
  expect(waiting.nodes[1]!.instances.some(inst => inst.threadId)).toBe(false);
  expect(h.core.threads.get(childId).backgroundWait).toMatchObject({ state: 'waiting', for: 'Pending CI' });

  // The work ends and wakes the step: that turn's answer is the step's result.
  first.ctx.backgroundFinished!('ci-1', 'completed');
  first.ctx.wake!('CI finished: green.');
  await waitFor(() => runs.get(childId) !== first, 5000);
  runs.get(childId)!.finish('CI is green on the final head.');
  await waitFor(() => step().status === 'done');
  expect(step().result).toBe('CI is green on the final head.');
  const report = () => h.core.workflows.get(threadId, run.id).nodes[1]!.instances[0];
  await waitFor(() => !!report()?.threadId && runs.has(report()!.threadId!));
  const prompt = prompts.find(entry => entry.threadId === report()!.threadId)!.prompt;
  expect(prompt).toContain('CI is green on the final head.');
  expect(prompt).not.toContain('Checkpoint: waiting for CI.');
});

/** Past the wake grace of background work that ended now. */
function afterGrace() {
  const later = Date.now() + BACKGROUND_WAKE_GRACE_MS + 1000;
  const clock = spyOn(Date, 'now').mockImplementation(() => later);
  restores.push(() => clock.mockRestore());
  return clock;
}

test('a step whose background work completes without a wake is asked for its final answer, never settled on the checkpoint', async () => {
  const { h, threadId, run, step, childId, first, runs, prompts } = await setup();
  // An ACP command reports its end through backgroundFinished and opens no turn.
  first.ctx.backgroundFinished!('ci-1', 'completed');
  const clock = afterGrace();
  await waitFor(() => runs.get(childId) !== first, 5000);
  clock.mockRestore();
  expect(prompts.filter(entry => entry.threadId === childId).at(-1)!.prompt).toContain('Your background work (Pending CI) completed, but no turn of yours followed it');
  expect(step()).toMatchObject({ status: 'running', result: null });
  runs.get(childId)!.finish('CI passed: 12 checks green.');
  await waitFor(() => step().status === 'done');
  expect(step().result).toBe('CI passed: 12 checks green.');
  const report = () => h.core.workflows.get(threadId, run.id).nodes[1]!.instances[0];
  await waitFor(() => !!report()?.threadId && runs.has(report()!.threadId!));
  expect(prompts.find(entry => entry.threadId === report()!.threadId)!.prompt).not.toContain('Checkpoint: waiting for CI.');
});

test('a step that cannot be asked for its final answer fails with a reason a retry clears', async () => {
  const { h, owner, threadId, run, step, childId, first, runs } = await setup();
  const start = spyOn(h.core.threads, 'startTurn').mockImplementation(() => { throw new Error('account signed out'); });
  restores.push(() => start.mockRestore());
  first.ctx.backgroundFinished!('ci-1', 'completed');
  const clock = afterGrace();
  await waitFor(() => step().status === 'failed', 5000);
  clock.mockRestore();
  expect(step().error).toContain('completed without waking it, and asking for its final result failed: account signed out');
  expect(step().result).toBeNull();
  // Signed in again, the retry runs the step in the same conversation and its answer is the result.
  start.mockRestore();
  expect(await owner.call('workflows.control', { threadId, runId: run.id, action: 'retry', stepId: 'watch' })).toMatchObject({ status: 'running' });
  await waitFor(() => runs.get(childId) !== first, 5000);
  expect(step()).toMatchObject({ status: 'running', error: null, threadId: childId });
  runs.get(childId)!.finish('CI passed after sign-in.');
  await waitFor(() => step().status === 'done');
  expect(step()).toMatchObject({ result: 'CI passed after sign-in.', error: null });
});

test('a step stopped while it waits on its background work reads stopped, not failed on the lost wait', async () => {
  const { h, owner, threadId, step, childId } = await setup();
  expect(await owner.call('delegation.stop', { threadId, agentId: childId })).toMatchObject({ stopped: 1 });
  // Stopping it ended the work it waited on: a stop the user asked for, not a failure of the step.
  await waitFor(() => step().status !== 'running', 5000);
  expect(step()).toMatchObject({ status: 'stopped', error: 'Stopped', result: null });
});

test.each(['run', 'team'] as const)('a paused %s asks nothing of a step whose work completed, and its resume asks for the final answer', async paused => {
  const { h, owner, threadId, run, step, childId, first, runs, prompts } = await setup();
  // The team's pause reaches the run only on its next advance, after the work completed.
  if (paused === 'run') await owner.call('workflows.control', { threadId, runId: run.id, action: 'pause' });
  else await owner.call('delegation.configure', { threadId, config: { ...h.core.delegation.config(threadId), paused: true } });
  first.ctx.backgroundFinished!('ci-1', 'completed');
  const asked = spyOn(h.core.workflows, 'unwoken');
  restores.push(() => asked.mockRestore());
  const before = asked.mock.calls.length;
  const clock = afterGrace();
  // A check past the grace, then time for an ask it might have sent to start a turn.
  await waitFor(() => asked.mock.calls.length > before, 5000);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(runs.get(childId)).toBe(first);
  expect(step()).toMatchObject({ status: 'running', result: null });
  if (paused === 'run') await owner.call('workflows.control', { threadId, runId: run.id, action: 'resume' });
  // The run asks its step; the team sends it no second continuation.
  else expect(await owner.call('delegation.resume', { threadId })).toMatchObject({ unpaused: true, agents: [], runs: [run.id] });
  await waitFor(() => runs.get(childId) !== first, 5000);
  clock.mockRestore();
  expect(prompts.filter(entry => entry.threadId === childId).at(-1)!.prompt).toContain('Your background work (Pending CI) completed');
  runs.get(childId)!.finish('CI passed.');
  await waitFor(() => step().status === 'done');
  expect(step().result).toBe('CI passed.');
});

test('an ordinary child that cannot be asked for its final answer tells its parent, and a resume continues it', async () => {
  const { h, owner, threadId, checkpoint, runs } = await parent();
  const spawned = await owner.call('delegation.spawn', { threadId, profileId: 'fast', task: 'Watch CI.', requestId: 'watch' });
  const childId = spawned.thread.id;
  const first = await checkpoint(childId);
  const start = spyOn(h.core.threads, 'startTurn').mockImplementation(() => { throw new Error('account signed out'); });
  restores.push(() => start.mockRestore());
  first.ctx.backgroundFinished!('ci-1', 'completed');
  const clock = afterGrace();
  const note = () => h.core.delegation.get(threadId).messages.find(letter => letter.from.threadId === childId && letter.text.includes(': interrupted'));
  await waitFor(() => !!note(), 5000);
  start.mockRestore();
  expect(note()!.text).toContain('completed without waking it, and asking for its final result failed: account signed out');
  expect(h.core.delegation.resume(threadId, childId, 'owner').agents).toEqual([childId]);
  await waitFor(() => runs.get(childId) !== first, 5000);
  clock.mockRestore();
  expect(runs.get(childId)!.ctx.prompt).toContain('Continue your task');
});

test('a step whose background work ends without waking it fails with why, and what depends on it never starts', async () => {
  const { h, threadId, run, step, childId } = await setup();
  // Its agent process goes away with the task: nothing is left to wake it.
  h.core.threads.agentState.cancelBackground(childId);
  await waitFor(() => step().status === 'failed', 5000);
  expect(step().error).toContain('Pending CI');
  expect(step().error).toContain('its agent process was ended');
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[1]!.instances.every(inst => inst.status === 'stopped'));
  expect(h.core.workflows.get(threadId, run.id).nodes[1]!.instances.some(inst => inst.threadId)).toBe(false);
});

test.each(['live', 'completed'] as const)('stopping a run ends the work of a step at rest on its checkpoint (%s) and settles its worktree', async work => {
  const { h, owner, threadId, run, step, childId, first } = await setup();
  // Completed in the wake grace: nothing is left in the live map, the step still rests on its checkpoint.
  if (work === 'completed') first.ctx.backgroundFinished!('ci-1', 'completed');
  const release = spyOn(h.core.threads, 'releaseAgent');
  const settle = spyOn(h.core.delegation.worktrees, 'settle');
  restores.push(() => { release.mockRestore(); settle.mockRestore(); });
  await owner.call('workflows.control', { threadId, runId: run.id, action: 'stop' });
  await waitFor(() => step().status === 'stopped');
  expect(release).toHaveBeenCalledWith(childId);
  expect(settle).toHaveBeenCalledWith(childId);
  expect(h.core.threads.agentState.background.get(childId) ?? []).toEqual([]);
  expect(h.core.workflows.get(threadId, run.id).status).toBe('stopped');
});
