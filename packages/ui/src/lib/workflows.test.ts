import { expect } from 'vitest';
import { test } from '../test/fake-client';
import { RpcErrorCode, type WorkflowPlan, type WorkflowRun } from '@boite/contracts';
import { STEP_GAP, STEP_MIN, edgesOf, fitsPhase, nodeProgress, phasesOf, retryable, routeOf, runProgress, shown } from './workflow-view';
import { FakeContext } from './fake-client/context';
import { seed } from './fake-client/seed';

const plan: WorkflowPlan = {
  name: 'Check the lexer',
  steps: [
    { id: 'scan', profile: 'implementer', task: 'List the lexer files.', output: { files: ['string'] } },
    { id: 'review', profile: 'reviewer', forEach: 'scan.files', task: 'Review {{item}}.' },
    { id: 'report', profile: 'reviewer', after: ['review'], task: 'Summarize {{review}}.' }
  ]
};

test.each([undefined, {maxSteps: 24}])('a mixed fake workflow retains ordinary slots without blocking shared work with limits %j', limits => {
  const ctx = new FakeContext({delayMs: 0}); seed(ctx);
  try {
    let run!: WorkflowRun;
    ctx.workflows.hold(() => {run = ctx.workflows.start('t-trace', {name: 'Mixed slots', ...(limits ? {limits} : {}), steps: [
      ...Array.from({length: 5}, (_, i) => ({id: `local${i}`, task: 'Ordinary work'})),
      {id: 'remote', task: 'Shared work', compute: {sharedProjectId: 'shared', host: {ownerCoreId: 'a'.repeat(64), coreId: 'b'.repeat(64), projectId: 'project'}, profileId: 'conversation', baseCommit: 'c'.repeat(40)}},
    ]}, 'mixed-slots', undefined, 'user');});
    expect(run.nodes.filter(n => n.id.startsWith('local')).flatMap(n => n.instances).filter(i => i.status === 'running')).toHaveLength(3);
    expect(run.nodes.find(n => n.id === 'remote')!.instances[0]!.status).toBe('running');
  } finally {ctx.workflows.close();}
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('the workflow never reached the expected state');
}

test('the seeded run lays out as four phases with an arrow per dependency', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const [run] = await client.call('workflows.list', { threadId: 't-trace' });
  expect(run!.name).toBe('Review the parser');
  expect(phasesOf(run!).map(phase => phase.map(node => node.id))).toEqual([['scan'], ['review'], ['fix', 'tests'], ['report']]);
  expect(edgesOf(run!)).toEqual([
    { from: 'scan', to: 'review' },
    { from: 'review', to: 'fix' },
    { from: 'review', to: 'tests' },
    { from: 'fix', to: 'report' },
    { from: 'tests', to: 'report' }
  ]);
  const review = run!.nodes.find(node => node.id === 'review')!;
  expect(nodeProgress(review)).toMatchObject({ done: 1, total: 3, running: 2 });
  expect(runProgress(run!)).toEqual({ done: 1, total: 5 });
  expect(routeOf(review, [])).toMatchObject({ providerId: review.instances[0]!.providerId });
  expect(routeOf(review, [])?.effort).toBe('high');
  expect(run!.usage.inputTokens).toBe(2800);
  expect(review.instances[0]!.usage?.inputTokens).toBe(1400);
  expect(review.instances[1]!.usage).toBeNull();
  expect(shown(review.instances[0]!.output)).toContain('"bugs"');
});

test('the steps of a phase sit side by side only with room for each and the gaps between', () => {
  expect(fitsPhase(0, 1)).toBe(true);
  expect(fitsPhase(3 * STEP_MIN + 2 * STEP_GAP, 3)).toBe(true);
  expect(fitsPhase(3 * STEP_MIN + 2 * STEP_GAP - 1, 3)).toBe(false);
});

test('a started plan fans out over the first step output, ends and delivers', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const started = await client.call('workflows.start', { threadId: 't-scheduler', plan, requestId: 'lexer' }).catch(() => null);
  // t-scheduler has no team: a plan needs the owner's delegation profiles.
  expect(started).toBeNull();
  const run = await client.call('workflows.start', { threadId: 't-trace', plan, requestId: 'lexer' });
  expect(run.launchedBy).toBe('user');
  const again = await client.call('workflows.start', { threadId: 't-trace', plan, requestId: 'lexer' });
  expect(again.id).toBe(run.id);
  const done = await until(() => client.call('workflows.get', { threadId: 't-trace', runId: run.id }), value => value.status !== 'running');
  expect(done.status).toBe('done');
  expect(done.delivered).toBe(true);
  const review = done.nodes.find(node => node.id === 'review')!;
  expect(review.instances.map(inst => inst.label)).toHaveLength(3);
  expect(review.instances.every(inst => inst.threadId && inst.status === 'done')).toBe(true);
  expect(done.nodes.find(node => node.id === 'report')!.instances[0]!.task).toContain('Summarize');
});

test('a failed step fails the run and only the owner retries it', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const failing: WorkflowPlan = { name: 'Doomed', steps: [{ id: 'try', profile: 'implementer', task: 'Please fail now.' }, { id: 'next', profile: 'reviewer', after: ['try'], task: 'Never runs.' }] };
  const run = await client.call('workflows.start', { threadId: 't-trace', plan: failing, requestId: 'doomed' });
  const failed = await until(() => client.call('workflows.get', { threadId: 't-trace', runId: run.id }), value => value.status !== 'running');
  expect(failed.status).toBe('failed');
  expect(failed.nodes.map(node => node.status)).toEqual(['failed', 'waiting']);
  expect(retryable(failed)).toBe(true);
  client.becomes('session');
  await expect(client.call('workflows.control', { threadId: 't-trace', runId: run.id, action: 'retry', stepId: 'try' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  client.becomes('owner');
  const retried = await client.call('workflows.control', { threadId: 't-trace', runId: run.id, action: 'retry', stepId: 'try' });
  expect(retried.status).toBe('running');
  await until(() => client.call('workflows.get', { threadId: 't-trace', runId: run.id }), value => value.status === 'failed');
});

test('retry past an archived fake child retains its reported tokens without accepting its output', async () => {
  const ctx = new FakeContext({ delayMs: 0 });
  seed(ctx);
  const workflows = ctx.workflows;
  try {
    let run!: WorkflowRun;
    workflows.hold(() => { run = workflows.start('t-trace', { name: 'Retry usage', steps: [{ id: 'check', task: 'Check.' }] }, 'retry-usage', undefined, 'user'); });
    await workflows.call('workflows.control', { threadId: 't-trace', runId: run.id, action: 'stop' });
    const oldId = run.nodes[0]!.instances[0]!.threadId!;
    const old = ctx.thread(oldId);
    old.archived = true;
    old.turns[0]!.usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 25, costUsdEquivalent: 0.01 };
    let retried!: Promise<unknown>;
    workflows.hold(() => { retried = workflows.call('workflows.control', { threadId: 't-trace', runId: run.id, action: 'retry' }); });
    const running = await retried as WorkflowRun;
    expect(running.nodes[0]!.instances[0]!.threadId).not.toBe(oldId);
    expect(running.usage).toEqual(old.turns[0]!.usage);
    expect(running.nodes[0]!.instances[0]!.usage).toEqual(old.turns[0]!.usage);
    await expect(workflows.call('workflows.output', { threadId: oldId, value: 'stale' })).rejects.toThrow('is not running');
    workflows.finish(run.id, 'check');
    const done = await workflows.call('workflows.get', { threadId: 't-trace', runId: run.id }) as WorkflowRun;
    expect(done.status).toBe('done');
    expect(done.usage).toEqual({ inputTokens: 1500, outputTokens: 370, cacheReadTokens: 2800, cacheWriteTokens: 25, costUsdEquivalent: 0.01 + 0.018 });
    expect(done.nodes[0]!.instances[0]!.usage).toEqual(done.usage);
  } finally { workflows.close(); ctx.agents.close(); ctx.plugins.close(); }
});

test('retrying one of two failed steps names the other and leaves the run as it was', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const pair: WorkflowPlan = { name: 'Pair', limits: { maxConcurrent: 2 }, steps: [{ id: 'left', profile: 'implementer', task: 'Please fail now.' }, { id: 'right', profile: 'implementer', task: 'Please fail now.' }] };
  const run = await client.call('workflows.start', { threadId: 't-trace', plan: pair, requestId: 'pair' });
  const failed = await until(() => client.call('workflows.get', { threadId: 't-trace', runId: run.id }), value => value.status !== 'running');
  expect(failed.nodes.map(node => node.status)).toEqual(['failed', 'failed']);
  await expect(client.call('workflows.control', { threadId: 't-trace', runId: run.id, action: 'retry', stepId: 'left' }))
    .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: 'the run stays stopped while right has failed; retry that step too, or retry the whole run without naming a step' });
  const unchanged = await client.call('workflows.get', { threadId: 't-trace', runId: run.id });
  expect([unchanged.status, ...unchanged.nodes.map(node => node.status)]).toEqual(['failed', 'failed', 'failed']);
  const retried = await client.call('workflows.control', { threadId: 't-trace', runId: run.id, action: 'retry' });
  expect(retried.status).toBe('running');
});

test('a failed step stops what never launched, and a paused run still ends its running steps', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const narrow: WorkflowPlan = { name: 'Narrow', limits: { maxConcurrent: 1 }, steps: [{ id: 'try', profile: 'implementer', task: 'Please fail now.' }, { id: 'side', profile: 'reviewer', task: 'Waits its turn.' }] };
  const run = await client.call('workflows.start', { threadId: 't-trace', plan: narrow, requestId: 'narrow' });
  const failed = await until(() => client.call('workflows.get', { threadId: 't-trace', runId: run.id }), value => value.status !== 'running');
  expect([failed.status, failed.error]).toEqual(['failed', 'try: The turn failed']);
  expect(failed.nodes.map(node => node.status)).toEqual(['failed', 'stopped']);
  expect(failed.nodes[1]!.instances.map(inst => [inst.status, inst.threadId, inst.error])).toEqual([['stopped', null, 'Not started: another step of the run failed']]);
  // Retrying the failed step reopens the one it held back.
  const retried = await client.call('workflows.control', { threadId: 't-trace', runId: run.id, action: 'retry', stepId: 'try' });
  expect(retried.status).toBe('running');
  expect(retried.nodes[1]!.instances[0]!.error).toBeNull();
  await until(() => client.call('workflows.get', { threadId: 't-trace', runId: run.id }), value => value.status === 'failed');

  const one = await client.call('workflows.start', { threadId: 't-trace', plan: { name: 'One', steps: [{ id: 'a', task: 'Quick.' }] }, requestId: 'one' });
  await client.call('workflows.control', { threadId: 't-trace', runId: one.id, action: 'pause' });
  const done = await until(() => client.call('workflows.get', { threadId: 't-trace', runId: one.id }), value => value.status !== 'paused');
  expect(done.status).toBe('done');
});

test('Mark done stops a paused run, as the core does', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const source = await client.call('threads.get', { threadId: 't-trace' });
  const { id: threadId } = await client.call('threads.create', { projectId: source.projectId!, providerId: source.providerId, accountId: source.accountId, model: source.model ?? undefined });
  const two = await client.call('workflows.start', { threadId, plan: { name: 'Two', steps: [{ id: 'a', task: 'Quick.' }, { id: 'b', task: 'Then {{a}}' }] }, requestId: 'two' });
  await client.call('workflows.control', { threadId, runId: two.id, action: 'pause' });
  await until(() => client.call('workflows.get', { threadId, runId: two.id }), value => value.nodes[0]!.status === 'done');
  expect((await client.call('threads.archive', { threadId, onlyIfIdle: true })).archived).toBe(true);
  expect((await client.call('workflows.get', { threadId, runId: two.id })).status).toBe('stopped');
});

test('an agent saves new templates but never replaces a saved one', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const saved = await client.call('workflows.templates.save', { threadId: 't-trace', name: 'Lexer', plan });
  client.becomes('agent');
  await expect(client.call('workflows.templates.save', { threadId: 't-trace', name: 'Lexer', plan })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('workflows.templates.save', { threadId: 't-trace', name: 'Other', plan, templateId: saved.id })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  expect((await client.call('workflows.templates.save', { threadId: 't-trace', name: 'Other', plan })).id).not.toBe(saved.id);
});

test('a paired device follows, pauses and stops a run but cannot start or resume one', async ({ createClient }) => {
  const phone = await createClient({ delayMs: 0, principal: 'session', delegationDemo: true });
  const [run] = await phone.call('workflows.list', { threadId: 't-trace' });
  await expect(phone.call('workflows.start', { threadId: 't-trace', plan, requestId: 'phone' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(phone.call('workflows.control', { threadId: 't-trace', runId: run!.id, action: 'pause' })).resolves.toMatchObject({ status: 'paused' });
  await expect(phone.call('workflows.control', { threadId: 't-trace', runId: run!.id, action: 'resume' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  const stopped = await phone.call('workflows.control', { threadId: 't-trace', runId: run!.id, action: 'stop' });
  expect(stopped.status).toBe('stopped');
  expect(stopped.nodes.find(node => node.id === 'review')!.instances.filter(inst => inst.status === 'stopped')).toHaveLength(2);
});

test('the store follows the runs of the open thread and of its parent from a step', async ({ createStore }) => {
  const { store, client } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  await store.loadWorkflows('t-trace');
  const [seeded] = store.workflowsOf('t-trace');
  expect(seeded?.status).toBe('running');
  const step = seeded!.nodes.find(node => node.id === 'review')!.instances[1]!.threadId!;
  expect(store.isWorkflowStep(step)).toBe(true);

  await store.controlWorkflow(seeded!, 'pause');
  await until(async () => store.workflowsOf('t-trace')[0] as WorkflowRun, value => value.status === 'paused');

  const saved = await store.saveWorkflowTemplate(seeded!, 'Parser review');
  expect(saved?.name).toBe('Parser review');
  expect(store.workflowTemplates.map(template => template.name)).toEqual(['Parser review']);

  await store.open(step);
  await store.loadWorkflows(step);
  expect(store.workflowsOf(step).map(run => run.id)).toContain(seeded!.id);
});
