import { expect, test } from 'vitest';
import { RpcErrorCode, type WorkflowPlan, type WorkflowRun } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { COLUMN_GAP, COLUMN_MIN, columnsOf, edgesOf, fitsColumns, nodeProgress, retryable, routeOf, runProgress, shown } from './workflow-view';

const plan: WorkflowPlan = {
  name: 'Check the lexer',
  steps: [
    { id: 'scan', profile: 'implementer', task: 'List the lexer files.', output: { files: ['string'] } },
    { id: 'review', profile: 'reviewer', forEach: 'scan.files', task: 'Review {{item}}.' },
    { id: 'report', profile: 'reviewer', after: ['review'], task: 'Summarize {{review}}.' }
  ]
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('the workflow never reached the expected state');
}

test('the seeded run lays out as four columns with an arrow per dependency', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  await client.connect();
  try {
    const [run] = await client.call('workflows.list', { threadId: 't-trace' });
    expect(run!.name).toBe('Review the parser');
    expect(columnsOf(run!).map(column => column.map(node => node.id))).toEqual([['scan'], ['review'], ['fix'], ['report']]);
    expect(edgesOf(run!)).toEqual([{ from: 'scan', to: 'review' }, { from: 'review', to: 'fix' }, { from: 'fix', to: 'report' }]);
    const review = run!.nodes.find(node => node.id === 'review')!;
    expect(nodeProgress(review)).toMatchObject({ done: 1, total: 3, running: 2 });
    expect(runProgress(run!)).toEqual({ done: 1, total: 4 });
    expect(routeOf(review, [])).toMatchObject({ providerId: review.instances[0]!.providerId });
    expect(shown(review.instances[0]!.output)).toContain('"bugs"');
  } finally { client.close(); }
});

test('columns fit side by side only with room for each and the arrows between', () => {
  expect(fitsColumns(0, 1)).toBe(true);
  expect(fitsColumns(3 * COLUMN_MIN + 2 * COLUMN_GAP, 3)).toBe(true);
  expect(fitsColumns(3 * COLUMN_MIN + 2 * COLUMN_GAP - 1, 3)).toBe(false);
});

test('a started plan fans out over the first step output, ends and delivers', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('a failed step fails the run and only the owner retries it', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('a paired device follows, pauses and stops a run but cannot start or resume one', async () => {
  const phone = new FakeClient({ delayMs: 0, principal: 'session', delegationDemo: true });
  await phone.connect();
  try {
    const [run] = await phone.call('workflows.list', { threadId: 't-trace' });
    await expect(phone.call('workflows.start', { threadId: 't-trace', plan, requestId: 'phone' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(phone.call('workflows.control', { threadId: 't-trace', runId: run!.id, action: 'pause' })).resolves.toMatchObject({ status: 'paused' });
    await expect(phone.call('workflows.control', { threadId: 't-trace', runId: run!.id, action: 'resume' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    const stopped = await phone.call('workflows.control', { threadId: 't-trace', runId: run!.id, action: 'stop' });
    expect(stopped.status).toBe('stopped');
    expect(stopped.nodes.find(node => node.id === 'review')!.instances.filter(inst => inst.status === 'stopped')).toHaveLength(2);
  } finally { phone.close(); }
});

test('the store follows the runs of the open thread and of its parent from a step', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  try {
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
  } finally {
    store.detach(); client.close();
  }
});
