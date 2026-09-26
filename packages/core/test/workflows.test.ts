import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { DelegationConfig, WorkflowPlan, WorkflowRun } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { runCli } from '../src/cli.ts';
import { AGENT_ENV } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

type Reply = string | { text?: string; status?: TurnResult['status']; hold?: boolean };

/** Every turn answers from `reply`; `hold` keeps it running until `finish`. */
function scripted(reply: (ctx: TurnContext) => Reply) {
  const prompts: { threadId: string; prompt: string }[] = [];
  const held = new Map<string, (text?: string, status?: TurnResult['status']) => void>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    prompts.push({ threadId: ctx.thread.id, prompt: ctx.prompt });
    let resolve!: (value: TurnResult) => void;
    const done = new Promise<TurnResult>(r => { resolve = r; });
    const finish = (text = '', status: TurnResult['status'] = 'done') => {
      held.delete(ctx.thread.id);
      if (text) {
        const id = ctx.emit.startMessage('assistant');
        ctx.emit.part(id, 0, { type: 'text', text });
        ctx.emit.complete(id, 'complete');
      }
      resolve({ status, sessionId: `session:${ctx.thread.id}`, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null } });
    };
    const answer = reply(ctx);
    const shaped = typeof answer === 'string' ? { text: answer } : answer;
    if (shaped.hold) held.set(ctx.thread.id, finish);
    else queueMicrotask(() => finish(shaped.text ?? 'ok', shaped.status ?? 'done'));
    return { done, stop() { finish('', 'stopped'); } };
  } }));
  return { prompts, held };
}

async function setup(patch: Partial<DelegationConfig> = {}) {
  const h = await startTestCore({ settings: { maxConcurrentTurns: 8, perAccountConcurrency: 8 } }); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const thread = h.core.threads.require(threadId);
  const config: DelegationConfig = { ...DEFAULT_DELEGATION_CONFIG, enabled: true, maxAgents: 8, maxConcurrent: 8, maxTurns: 100, profiles: [
    { id: 'fast', name: 'Fast', providerId: 'echo', accountId: thread.accountId, model: thread.model!, effort: null },
    { id: 'reviewer', name: 'Reviewer', providerId: 'echo', accountId: thread.accountId, model: thread.model!, effort: null },
  ], ...patch };
  await owner.call('delegation.configure', { threadId, config });
  return { h, owner, threadId, config };
}

const TASK = /Task, supplied as JSON data:\n([^\n]*)/;
const taskOf = (prompt: string) => { const m = TASK.exec(prompt); return m ? JSON.parse(m[1]!) as string : ''; };

const REVIEW: WorkflowPlan = {
  name: 'Review the parser',
  steps: [
    { id: 'scan', profile: 'fast', task: 'List the files.', output: { files: ['string'] } },
    { id: 'review', profile: 'reviewer', forEach: 'scan.files', task: 'Review {{item}} ({{index}})', output: { bugs: [{ line: 'number' }] } },
    { id: 'fix', profile: 'fast', when: { path: 'review.bugs', notEmpty: true }, task: 'Fix {{review.bugs}}' },
    { id: 'report', profile: 'fast', after: ['fix'], task: 'Report on {{review}}' },
  ],
};

async function settled(h: TestCore, threadId: string, runId: string, status: WorkflowRun['status'][] = ['done', 'failed', 'stopped']) {
  try {
    await waitFor(() => status.includes(h.core.workflows.get(threadId, runId).status), 3000);
  } catch {
    const run = h.core.workflows.get(threadId, runId);
    throw new Error(`run ${run.status} (${run.error}), wanted ${status.join(' or ')}: ${JSON.stringify(run.nodes.map(n => [n.id, n.status, n.error, n.instances.map(i => [i.key, i.status, i.error])]))}`);
  }
  return h.core.workflows.get(threadId, runId);
}

test('a plan runs as child threads: output feeds a fan-out, a false condition skips, the parent gets one result turn', async () => {
  const { prompts } = scripted(ctx => {
    const task = taskOf(ctx.prompt);
    if (task === 'List the files.') return 'Found two.\n```json\n{"files": ["a.ts", "b.ts"]}\n```';
    if (task.startsWith('Review a.ts')) return '```json\n{"bugs": []}\n```';
    if (task.startsWith('Review b.ts')) return '```json\n{"bugs": []}\n```';
    if (task.startsWith('Report on')) return 'All clean.';
    return 'parent acknowledged';
  });
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: REVIEW, requestId: 'review-1' });
  expect(run.nodes.map(n => n.id)).toEqual(['scan', 'review', 'fix', 'report']);
  expect(run.nodes.find(n => n.id === 'fix')!.after).toEqual(['review']);
  const done = await settled(h, threadId, run.id);
  expect([done.status, done.error]).toEqual(['done', null]);
  const review = done.nodes.find(n => n.id === 'review')!;
  expect(review.instances.map(i => [i.key, i.label, i.status])).toEqual([['review#0', 'a.ts', 'done'], ['review#1', 'b.ts', 'done']]);
  expect(review.instances[1]!.task).toBe('Review b.ts (1)');
  expect(done.nodes.find(n => n.id === 'fix')!.status).toBe('skipped');
  expect(done.nodes.find(n => n.id === 'report')!.instances[0]!.task).toContain('"bugs": []');
  // Steps are ordinary children, held to the team's turn budget, and never mail the parent.
  const child = h.core.threads.require(review.instances[0]!.threadId!);
  expect(child.parentThreadId).toBe(threadId);
  expect(h.core.delegation.get(threadId).agents).toHaveLength(0);
  expect(h.core.delegation.get(threadId).messages).toHaveLength(0);
  // The result reaches the parent once, as a turn of its own.
  await waitFor(() => prompts.some(p => p.threadId === threadId && p.prompt.includes('Boite workflow done')));
  expect(prompts.filter(p => p.threadId === threadId && p.prompt.includes('Boite workflow')).length).toBe(1);
  await waitFor(() => h.core.workflows.get(threadId, run.id).delivered);
  expect(h.core.delegation.get(threadId).turnsUsed).toBe(5);
  // A retried start is the same run.
  expect((await owner.call('workflows.start', { threadId, plan: REVIEW, requestId: 'review-1' })).id).toBe(run.id);
  await expect(owner.call('workflows.start', { threadId, plan: { ...REVIEW, name: 'Other' }, requestId: 'review-1' })).rejects.toThrow('different content');
});

test('plans are refused by field before anything starts', async () => {
  scripted(() => 'ok');
  const { owner, threadId } = await setup();
  const bad = (plan: unknown) => owner.call('workflows.check', { threadId, plan: plan as WorkflowPlan });
  await expect(bad({ name: 'x', steps: [] })).rejects.toThrow('steps: expected at least one step');
  await expect(bad({ name: 'x', steps: [{ id: 'a', profile: 'nope', task: 't' }] })).rejects.toThrow('steps[0].profile: "nope" is not an approved profile; expected one of fast, reviewer');
  await expect(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: 'use {{b.x}}' }, { id: 'b', profile: 'fast', task: 'use {{a}}' }] })).rejects.toThrow('cycle a -> b -> a');
  await expect(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: '{{item}}' }] })).rejects.toThrow('{{item}} exists only in a step with forEach');
  await expect(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: 't', output: { n: 'integer' } }] })).rejects.toThrow('steps[0].output.n');
  await expect(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: 't', when: { path: 'a.b', equals: 1, empty: true } }] })).rejects.toThrow('exactly one of');
  await expect(bad({ name: 'x', limits: { maxSteps: 500 }, steps: [{ id: 'a', profile: 'fast', task: 't' }] })).rejects.toThrow('limits.maxSteps: expected an integer from 1 to 64');
  expect(await bad(REVIEW)).toEqual({ levels: [['scan'], ['review'], ['fix'], ['report']] });
});

test('a mismatched output is asked for once more, then the step fails and retry runs it again', async () => {
  let attempts = 0;
  const { prompts } = scripted(ctx => {
    if (ctx.thread.parentThreadId === null || ctx.thread.parentThreadId === undefined) return 'noted';
    attempts++;
    return attempts <= 2 ? 'no json here' : '```json\n{"files": []}\n```';
  });
  const { h, owner, threadId } = await setup();
  const plan: WorkflowPlan = { name: 'Scan', steps: [{ id: 'scan', profile: 'fast', task: 'List.', output: { files: ['string'] } }, { id: 'next', profile: 'fast', task: 'Use {{scan.files}}' }] };
  const run = await owner.call('workflows.start', { threadId, plan, requestId: 'scan' });
  const failed = await settled(h, threadId, run.id);
  expect(failed.status).toBe('failed');
  expect(failed.error).toBe('scan: output: the answer has no ```json block');
  expect(failed.nodes[1]!.status).toBe('waiting');
  expect(prompts.some(p => p.prompt.includes("does not match this workflow step's output shape"))).toBe(true);
  await waitFor(() => prompts.some(p => p.threadId === threadId && p.prompt.includes('Boite workflow failed')));
  const retried = await owner.call('workflows.control', { threadId, runId: run.id, action: 'retry', stepId: 'scan' });
  expect(retried.status).toBe('running');
  const done = await settled(h, threadId, run.id, ['done']);
  // An empty list is a finished fan-out input, and the retry reused the same child thread.
  expect(done.nodes[1]!.status).toBe('done');
  expect(new Set(prompts.filter(p => p.prompt.includes('step scan')).map(p => p.threadId)).size).toBe(1);
});

test('concurrency holds to the run limit, and stop ends running steps without waking the parent', async () => {
  const { prompts, held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const plan: WorkflowPlan = { name: 'Fan', limits: { maxConcurrent: 2 }, steps: [
    { id: 'list', profile: 'fast', task: 'x', output: 'any' },
  ] };
  // Output from the CLI door, checked against the shape on the spot.
  const run = await owner.call('workflows.start', { threadId, plan: { ...plan, steps: [{ id: 'list', profile: 'fast', task: 'x', output: { items: ['number'] } }, { id: 'each', profile: 'fast', forEach: 'list.items', task: 'do {{item}}' }] }, requestId: 'fan' });
  await waitFor(() => held.size === 1);
  const stepThread = h.core.workflows.get(threadId, run.id).nodes[0]!.instances[0]!.threadId!;
  const step = await connect(h.url, h.core.agents.tokenFor(stepThread));
  try {
    await expect(step.call('workflows.output', { threadId: stepThread, value: { items: ['1'] } })).rejects.toThrow('output.items[0]: expected a number');
    expect(await step.call('workflows.output', { threadId: stepThread, value: { items: [1, 2, 3, 4] } })).toEqual({ runId: run.id, step: 'list' });
    await expect(step.call('workflows.start', { threadId: stepThread, plan, requestId: 'nested' })).rejects.toThrow('cannot start a workflow');
  } finally { step.close(); }
  held.get(stepThread)!('Done.');
  await waitFor(() => held.size === 2);
  expect(h.core.workflows.get(threadId, run.id).nodes[1]!.instances.map(i => i.status)).toEqual(['running', 'running', 'waiting', 'waiting']);
  const stopped = await owner.call('workflows.control', { threadId, runId: run.id, action: 'stop' });
  expect(stopped.status).toBe('stopped');
  expect(stopped.nodes[1]!.instances.map(i => i.status)).toEqual(['stopped', 'stopped', 'stopped', 'stopped']);
  expect(stopped.nodes[1]!.status).toBe('stopped');
  await Bun.sleep(20);
  expect(prompts.some(p => p.threadId === threadId && p.prompt.includes('Boite workflow'))).toBe(false);
});

test('workflows need the owner-enabled team, and a paused team pauses the run until an owner resumes it', async () => {
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId, config } = await setup();
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    await owner.call('delegation.configure', { threadId, config: { ...config, enabled: false } });
    await expect(agent.call('workflows.start', { threadId, plan: REVIEW, requestId: 'off' })).rejects.toThrow('enables delegation');
    await owner.call('delegation.configure', { threadId, config });
    const run = await agent.call('workflows.start', { threadId, plan: { name: 'Two', steps: [{ id: 'a', profile: 'fast', task: 'a' }, { id: 'b', profile: 'fast', task: 'b {{a}}' }] }, requestId: 'on' });
    expect(run.launchedBy).toBe('agent');
    await waitFor(() => held.size === 1);
    await owner.call('delegation.stop', { threadId });
    [...held.values()][0]!('A done');
    const paused = await settled(h, threadId, run.id, ['paused']);
    expect(paused.error).toContain('paused');
    await expect(agent.call('workflows.control', { threadId, runId: run.id, action: 'resume' })).rejects.toThrow('owner');
    await owner.call('workflows.control', { threadId, runId: run.id, action: 'resume' });
    expect(h.core.delegation.config(threadId).paused).toBe(false);
    await waitFor(() => held.size === 1);
    [...held.values()][0]!('B done');
    expect((await settled(h, threadId, run.id)).status).toBe('done');
  } finally { agent.close(); }
});

test('a restarted core pauses running workflows instead of spending on its own', async () => {
  scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'One', steps: [{ id: 'a', profile: 'fast', task: 'a' }] }, requestId: 'one' });
  await h.core.close();
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const record = next.workflows.get(threadId, run.id);
    expect(record.status).toBe('paused');
    expect(record.error).toContain('restarted');
    expect(record.nodes[0]!.instances[0]!.status).toBe('failed');
    expect(next.workflows.owns(record.nodes[0]!.instances[0]!.threadId!)).toBe(true);
  } finally { await next.close(); }
});

test('templates are kept per project, refreshed by name, started by id, and the CLI speaks the same plan', async () => {
  scripted(() => 'ok');
  const { h, owner, threadId } = await setup();
  const saved = await owner.call('workflows.templates.save', { threadId, name: 'Review', plan: REVIEW });
  const again = await owner.call('workflows.templates.save', { threadId, name: 'Review', plan: { ...REVIEW, steps: REVIEW.steps.slice(0, 1) } });
  expect(again.id).toBe(saved.id);
  expect((await owner.call('workflows.templates.list', { threadId })).map(t => [t.name, t.plan.steps.length])).toEqual([['Review', 1]]);
  const run = await owner.call('workflows.start', { threadId, plan: again.plan, templateId: again.id, requestId: 'tpl' });
  expect(run.templateId).toBe(again.id);
  expect(await owner.call('workflows.templates.remove', { threadId, templateId: again.id })).toEqual({ removed: true });

  const file = join(h.dataDir, 'plan.json');
  writeFileSync(file, JSON.stringify(REVIEW));
  const out: string[] = [];
  const env = { [AGENT_ENV.coreUrl]: h.url, [AGENT_ENV.token]: h.core.agents.tokenFor(threadId), [AGENT_ENV.threadId]: threadId };
  const code = await runCli(['workflow', 'check', file], { out: t => out.push(t), err: t => out.push(t), env, cwd: h.dataDir });
  expect(code).toBe(0);
  expect(out.join('')).toContain('column 2: review');
  out.length = 0;
  expect(await runCli(['workflow', 'check', '{"name":"x","steps":[{"id":"a","profile":"gone","task":"t"}]}'], { out: t => out.push(t), err: t => out.push(t), env, cwd: h.dataDir })).toBe(1);
  expect(out.join('')).toContain('steps[0].profile');
});
