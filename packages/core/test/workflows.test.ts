import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { DelegationConfig, Turn, WorkflowPlan, WorkflowRun } from '@boite/contracts';
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
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const thread = h.core.threads.require(threadId);
  const config: DelegationConfig = { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [
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
  // Steps are ordinary children, using the team's profiles, and never mail the parent.
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
  const recorded = await owner.call('workflows.get', { threadId, runId: run.id });
  await owner.call('threads.remove', { threadId });
  await owner.call('threads.restore', { threadId });
  expect(await owner.call('workflows.get', { threadId, runId: run.id })).toEqual(recorded);
  expect(h.core.scheduler.state().running).toEqual([]);
});

test('plans are refused by field before anything starts', async () => {
  scripted(() => 'ok');
  const { owner, threadId } = await setup();
  const bad = (plan: unknown) => owner.call('workflows.check', { threadId, plan: plan as WorkflowPlan });
  await expect(bad({ name: 'x', steps: [] })).rejects.toThrow('steps: expected at least one step');
  await expect(bad({ name: 'x', steps: [{ id: 'a', profile: 'nope', task: 't' }] })).rejects.toThrow('steps[0].profile: "nope" is not a profile of this thread; expected one of fast, reviewer, or leave profile out');
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

test.each(['stop', 'pause', 'archive'] as const)('a pending output correction respects %s before its dispatch', async action => {
  const { prompts, held } = scripted(ctx => ctx.prompt.includes('does not match')
    ? '```json\n{"files": []}\n```'
    : ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', {
    threadId, requestId: `correction-${action}`,
    plan: { name: 'Correct output', steps: [{ id: 'scan', profile: 'fast', task: 'List.', output: { files: ['string'] } }] },
  });
  const childId = run.nodes[0]!.instances[0]!.threadId!;
  await waitFor(() => held.has(childId));
  let controlled = false;
  const off = h.core.bus.onAny((name, payload) => {
    if (name !== 'turn.finished' || (payload as { threadId: string }).threadId !== childId || controlled) return;
    controlled = true;
    if (action === 'archive') h.core.threads.archive(threadId, true);
    else h.core.workflows.control({ threadId, runId: run.id, action }, 'owner');
  });
  try {
    held.get(childId)!('missing structured result');
    await waitFor(() => controlled);
    await Bun.sleep(25);
    expect(prompts.filter(prompt => prompt.threadId === childId)).toHaveLength(1);
    expect(h.core.workflows.get(threadId, run.id).status).toBe(action === 'pause' ? 'paused' : 'stopped');
    if (action === 'pause') {
      await owner.call('workflows.control', { threadId, runId: run.id, action: 'resume' });
      await settled(h, threadId, run.id, ['done']);
      expect(prompts.filter(prompt => prompt.threadId === childId)).toHaveLength(2);
      expect(h.core.workflows.get(threadId, run.id).nodes[0]!.instances[0]!.attempts).toBe(2);
    }
  } finally { off(); }
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

test('a workflow needs no team: a step without a profile runs on the conversation model and the parent gets the result', async () => {
  const { prompts } = scripted(ctx => ctx.thread.parentThreadId ? 'Step done.' : 'parent acknowledged');
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    expect(h.core.delegation.config(threadId)).toEqual(DEFAULT_DELEGATION_CONFIG);
    const plan: WorkflowPlan = { name: 'Plain', steps: [{ id: 'a', task: 'a' }, { id: 'b', task: 'b {{a}}' }] };
    const run = await agent.call('workflows.start', { threadId, plan, requestId: 'plain' });
    expect(run.nodes.map(n => n.profileId)).toEqual([null, null]);
    const done = await settled(h, threadId, run.id);
    expect([done.status, done.error]).toEqual(['done', null]);
    const parent = h.core.threads.require(threadId);
    const child = h.core.threads.require(done.nodes[1]!.instances[0]!.threadId!);
    expect([child.providerId, child.accountId, child.model]).toEqual([parent.providerId, parent.accountId, parent.model]);
    expect(done.nodes[1]!.instances[0]!.model).toBe(parent.model!);
    await waitFor(() => prompts.some(p => p.threadId === threadId && p.prompt.includes('Boite workflow done')));
    await waitFor(() => h.core.workflows.get(threadId, run.id).delivered);
    // Nothing was configured along the way, and a name that is no profile still says how to go without one.
    expect(h.core.journal.getSetting(`delegation:${threadId}`)).toBeUndefined();
    await expect(agent.call('workflows.check', { threadId, plan: { name: 'x', steps: [{ id: 'a', profile: 'fast', task: 't' }] } })).rejects.toThrow('none is configured: leave profile out');
  } finally { agent.close(); }
});

test('a failed turn of a conversation without a team pauses its run until the owner resumes it', async () => {
  let fail = true;
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : fail ? { status: 'error' } : 'parent acknowledged');
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Two', steps: [{ id: 'a', task: 'a' }, { id: 'b', task: 'b {{a}}' }] }, requestId: 'two' });
  await waitFor(() => held.size === 1);
  await owner.call('turns.start', { threadId, prompt: 'Carry on' });
  const paused = await settled(h, threadId, run.id, ['paused']);
  expect(paused.error).toContain('failed');
  fail = false;
  [...held.values()][0]!('A done');
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.status === 'done');
  expect(h.core.workflows.get(threadId, run.id).nodes[1]!.instances).toHaveLength(0);
  await owner.call('workflows.control', { threadId, runId: run.id, action: 'resume' });
  await waitFor(() => held.size === 1);
  [...held.values()][0]!('B done');
  expect((await settled(h, threadId, run.id)).status).toBe('done');
});

test('a paused team pauses the run until an owner resumes it', async () => {
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId, config } = await setup();
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
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

test.each(['running', 'correction'] as const)('a restarted core pauses %s workflows instead of spending on its own, and resume reuses the step', async phase => {
  const { prompts, held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'One', steps: [{ id: 'a', profile: 'fast', task: 'a', ...(phase === 'correction' ? { output: { files: ['string'] } } : {}) }] }, requestId: 'one' });
  await waitFor(() => held.size === 1);
  const child = run.nodes[0]!.instances[0]!.threadId!;
  if (phase === 'correction') {
    const off = h.core.bus.onAny((name, payload) => {
      if (name === 'turn.finished' && (payload as Turn).threadId === child) h.core.workflows.beginClose();
    });
    held.get(child)!('missing structured result');
    await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.instances[0]!.outputCorrection !== undefined);
    off();
  }
  await h.core.close();
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const record = next.workflows.get(threadId, run.id);
    expect(record.status).toBe('paused');
    expect(record.error).toContain('restarted');
    const inst = record.nodes[0]!.instances[0]!;
    expect(inst.status).toBe('waiting');
    if (phase === 'running') expect(inst.error).toBe('Interrupted by a core restart');
    else { expect(inst.outputCorrection).toContain('does not match'); expect(inst.attempts).toBe(2); }
    expect(next.workflows.owns(inst.threadId!)).toBe(true);
    await Bun.sleep(25);
    expect(prompts.filter(prompt => prompt.threadId === child)).toHaveLength(1);
    next.workflows.control({ threadId, runId: run.id, action: 'resume' }, 'owner');
    await waitFor(() => held.size === 1);
    const again = prompts.filter(p => p.threadId === inst.threadId).at(-1)!.prompt;
    expect(again).toContain(phase === 'running' ? 'Interrupted by a core restart' : 'does not match');
    [...held.values()][0]!(phase === 'running' ? 'A done' : '```json\n{"files": []}\n```');
    await waitFor(() => next.workflows.get(threadId, run.id).status === 'done');
    // The same child thread ran it again.
    expect(next.workflows.get(threadId, run.id).nodes[0]!.instances[0]!.threadId).toBe(inst.threadId);
  } finally { await next.close(); }
});

test('an agent changes only the runs it started, and a paused run waits for the owner', async () => {
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const mine = await owner.call('workflows.start', { threadId, plan: { name: 'Mine', steps: [{ id: 'a', profile: 'fast', task: 'a' }] }, requestId: 'mine' });
    await waitFor(() => held.size === 1);
    for (const action of ['pause', 'stop', 'retry'] as const) {
      await expect(agent.call('workflows.control', { threadId, runId: mine.id, action })).rejects.toThrow('the user started this run');
    }
    await expect(agent.call('workflows.extend', { threadId, runId: mine.id, steps: [{ id: 'b', profile: 'fast', task: 'b' }], requestId: 'more' })).rejects.toThrow('the user started this run');
    await owner.call('workflows.control', { threadId, runId: mine.id, action: 'stop' });
    const theirs = await agent.call('workflows.start', { threadId, plan: { name: 'Theirs', steps: [{ id: 'a', profile: 'fast', task: 'a' }] }, requestId: 'theirs' });
    await waitFor(() => held.size === 1);
    expect((await agent.call('workflows.control', { threadId, runId: theirs.id, action: 'pause' })).status).toBe('paused');
    await expect(agent.call('workflows.control', { threadId, runId: theirs.id, action: 'retry' })).rejects.toThrow('the owner resumes it');
    await expect(agent.call('workflows.control', { threadId, runId: theirs.id, action: 'resume' })).rejects.toThrow('owner action');
    expect((await agent.call('workflows.control', { threadId, runId: theirs.id, action: 'stop' })).status).toBe('stopped');
  } finally { agent.close(); }
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

test('a failed step stops what never launched, and a retry past an archived conversation opens a new one', async () => {
  const { held } = scripted(ctx => !ctx.thread.parentThreadId ? 'noted' : taskOf(ctx.prompt) === 'x' ? '```json\n{"items": [1, 2, 3, 4]}\n```' : { hold: true });
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Fan', limits: { maxConcurrent: 2 }, steps: [
    { id: 'list', profile: 'fast', task: 'x', output: { items: ['number'] } },
    { id: 'each', profile: 'fast', forEach: 'list.items', task: 'do {{item}}' },
  ] }, requestId: 'fan' });
  await waitFor(() => held.size === 2);
  const first = h.core.workflows.get(threadId, run.id).nodes[1]!.instances[0]!.threadId!;
  const second = h.core.workflows.get(threadId, run.id).nodes[1]!.instances[1]!.threadId!;
  held.get(first)!('', 'error');
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[1]!.instances[0]!.status === 'failed');
  // The run is halted but not over while a step it launched still works.
  expect(h.core.workflows.get(threadId, run.id).status).toBe('running');
  held.get(second)!('Two done.');
  const failed = await settled(h, threadId, run.id);
  expect(failed.status).toBe('failed');
  expect(failed.error).toStartWith('each: ');
  const each = failed.nodes[1]!;
  expect(each.status).toBe('failed');
  expect(each.instances.map(i => [i.status, i.threadId === null])).toEqual([['failed', false], ['done', false], ['stopped', true], ['stopped', true]]);
  expect(each.instances[2]!.error).toBe('Not started: another step of the run failed');

  await owner.call('threads.archive', { threadId: first });
  await owner.call('workflows.control', { threadId, runId: run.id, action: 'retry' });
  await waitFor(() => held.size === 2);
  const retried = h.core.workflows.get(threadId, run.id).nodes[1]!.instances;
  expect(retried[0]!.threadId).not.toBeNull();
  expect(retried[0]!.threadId).not.toBe(first);
  expect(retried.map(i => i.status)).toEqual(['running', 'done', 'running', 'waiting']);
  // The archived conversation speaks for nothing once the step moved on.
  const stale = await connect(h.url, h.core.agents.tokenFor(first));
  try {
    await expect(stale.call('workflows.output', { threadId: first, value: null })).rejects.toThrow('is not running');
  } finally { stale.close(); }
  for (const finish of [...held.values()]) finish('ok');
  await waitFor(() => held.size === 1);
  for (const finish of [...held.values()]) finish('ok');
  expect((await settled(h, threadId, run.id)).status).toBe('done');
});

test('retrying the failed step also reopens a parallel step that stopped before it launched', async () => {
  const { held } = scripted(ctx => !ctx.thread.parentThreadId ? 'noted' : taskOf(ctx.prompt) === 'x' ? '```json\n{"items": [1, 2, 3]}\n```' : { hold: true });
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Side', limits: { maxConcurrent: 2 }, steps: [
    { id: 'lone', profile: 'fast', task: 'lone' },
    { id: 'list', profile: 'fast', task: 'x', output: { items: ['number'] } },
    { id: 'each', profile: 'fast', forEach: 'list.items', task: 'do {{item}}' },
  ] }, requestId: 'side' });
  await waitFor(() => held.size === 2);
  const lone = h.core.workflows.get(threadId, run.id).nodes[0]!.instances[0]!.threadId!;
  const first = h.core.workflows.get(threadId, run.id).nodes[2]!.instances[0]!.threadId!;
  held.get(lone)!('', 'error');
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.status === 'failed');
  held.get(first)!('One done.');
  const failed = await settled(h, threadId, run.id);
  expect(failed.nodes[2]!.status).toBe('stopped');
  expect(failed.nodes[2]!.instances.map(i => i.status)).toEqual(['done', 'stopped', 'stopped']);

  await owner.call('workflows.control', { threadId, runId: run.id, action: 'retry', stepId: 'lone' });
  await waitFor(() => held.size === 2);
  const reopened = h.core.workflows.get(threadId, run.id);
  expect(reopened.nodes[2]!.status).toBe('running');
  expect(reopened.nodes[2]!.instances.map(i => [i.status, i.error])).toEqual([['done', null], ['running', null], ['waiting', null]]);
  while (h.core.workflows.get(threadId, run.id).status === 'running') {
    for (const finish of [...held.values()]) finish('ok');
    await Bun.sleep(20);
  }
  expect((await settled(h, threadId, run.id)).status).toBe('done');
});

test('a paused run lets its running steps end, and is done once every step is', async () => {
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const two = await owner.call('workflows.start', { threadId, plan: { name: 'Two', steps: [{ id: 'a', profile: 'fast', task: 'a' }, { id: 'b', profile: 'fast', task: 'b {{a}}' }] }, requestId: 'two' });
  await waitFor(() => held.size === 1);
  await owner.call('workflows.control', { threadId, runId: two.id, action: 'pause' });
  [...held.values()][0]!('A done');
  await waitFor(() => h.core.workflows.get(threadId, two.id).nodes[0]!.status === 'done');
  const paused = h.core.workflows.get(threadId, two.id);
  expect([paused.status, paused.nodes[1]!.status]).toEqual(['paused', 'waiting']);
  await owner.call('delegation.configure', { threadId, config: h.core.delegation.config(threadId) });
  await Bun.sleep(20);
  expect(held.size).toBe(0);
  expect(h.core.workflows.get(threadId, two.id).status).toBe('paused');
  await owner.call('workflows.control', { threadId, runId: two.id, action: 'stop' });

  const one = await owner.call('workflows.start', { threadId, plan: { name: 'One', steps: [{ id: 'a', profile: 'fast', task: 'a' }] }, requestId: 'one' });
  await waitFor(() => held.size === 1);
  await owner.call('workflows.control', { threadId, runId: one.id, action: 'pause' });
  [...held.values()][0]!('A done');
  expect((await settled(h, threadId, one.id)).status).toBe('done');
});

test('completed steps keep their summary while the team is paused and deliver once resumed', async () => {
  const { prompts, held: running } = scripted(() => ({ hold: true }));
  const { h, owner, threadId, config } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'One', steps: [{ id: 'a', profile: 'fast', task: 'a' }] }, requestId: 'one' });
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.status === 'running');
  await owner.call('delegation.configure', { threadId, config: { ...config, paused: true } });
  [...running.values()][0]!('Step done');
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.status === 'done');
  h.core.bus.emit('delegation.changed', { threadId });
  await Bun.sleep(20);
  const held = h.core.workflows.get(threadId, run.id);
  expect([held.status, held.delivered]).toEqual(['paused', false]);
  expect(held.deliveryError ?? null).toBeNull();
  expect(held.error).toContain('Subagents are paused');
  await owner.call('delegation.configure', { threadId, config });
  await settled(h, threadId, run.id);
  await waitFor(() => h.core.workflows.get(threadId, run.id).delivered);
  expect(h.core.workflows.get(threadId, run.id).deliveryError).toBeNull();
  await waitFor(() => prompts.some(p => p.threadId === threadId && p.prompt.includes('Boite workflow done')));
  await owner.call('delegation.configure', { threadId, config });
  await Bun.sleep(20);
  expect(prompts.filter(p => p.threadId === threadId && p.prompt.includes('Boite workflow done'))).toHaveLength(1);
});

test('an agent saves new templates but never replaces a saved one', async () => {
  scripted(() => 'ok');
  const { h, owner, threadId } = await setup();
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const saved = await agent.call('workflows.templates.save', { threadId, name: 'Review', plan: REVIEW });
    await expect(agent.call('workflows.templates.save', { threadId, name: 'Review', plan: { ...REVIEW, steps: REVIEW.steps.slice(0, 1) } })).rejects.toThrow('a template named "Review" already exists');
    await expect(agent.call('workflows.templates.save', { threadId, name: 'Other', plan: REVIEW, templateId: saved.id })).rejects.toThrow('already exists');
    expect((await owner.call('workflows.templates.save', { threadId, name: 'Review', plan: { ...REVIEW, steps: REVIEW.steps.slice(0, 1) } })).id).toBe(saved.id);
  } finally { agent.close(); }
});

test('a step names its model and reasoning level, and a level the model lacks is refused before anything starts', async () => {
  scripted(() => 'done');
  const { h, owner, threadId } = await setup();
  const bad: WorkflowPlan = { name: 'Bad', steps: [{ id: 'think', model: 'echo/echo', effort: 'ultra', task: 'Think.' }] };
  await expect(owner.call('workflows.check', { threadId, plan: bad })).rejects.toThrow('steps[0] (think)');
  await expect(owner.call('workflows.check', { threadId, plan: { name: 'Missing', steps: [{ id: 'think', model: 'no-such-model', task: 'Think.' }] } })).rejects.toThrow('no installed model');
  const run = await owner.call('workflows.start', { threadId, requestId: 'routes', plan: { name: 'Routes', steps: [
    { id: 'quick', model: 'echo', effort: 'low', task: 'Look quickly.' },
    { id: 'plain', after: ['quick'], task: 'Look again.' },
  ] } });
  const done = await settled(h, threadId, run.id, ['done']);
  const [quick, plain] = done.nodes.map(node => node.instances[0]!);
  expect([quick!.providerId, quick!.model, quick!.effort]).toEqual(['echo', 'echo', 'low']);
  expect(h.core.threads.require(quick!.threadId!).effort).toBe('low');
  expect(plain!.effort).toBe(h.core.threads.require(threadId).effort);
});

test('a step names a speed tier of its model, by id or label, and an unknown one is refused before anything starts', async () => {
  const { held } = scripted(ctx => ({ hold: ctx.thread.title.includes('gate') }));
  const { h, owner, threadId } = await setup();
  const echo = h.core.providers.require('echo').models.find(model => model.id === 'echo');
  if (!echo) throw new Error(`echo lists ${h.core.providers.require('echo').models.map(model => model.id).join(', ')}`);
  echo.speeds = [{ id: 'priority', label: 'Fast' }];
  h.core.journal.putThread({ ...h.core.threads.require(threadId), speed: 'priority' });
  const bad: WorkflowPlan = { name: 'Bad', steps: [{ id: 'play', model: 'echo/echo', speed: 'turbo', task: 'Play.' }] };
  await expect(owner.call('workflows.check', { threadId, plan: bad })).rejects.toThrow('steps[0] (play): speed: echo/echo has no "turbo" tier; expected Fast (priority)');
  await expect(owner.call('workflows.start', { threadId, requestId: 'bad-speed', plan: bad })).rejects.toThrow('has no "turbo" tier');
  await expect(owner.call('workflows.check', { threadId, plan: { name: 'Typed', steps: [{ id: 'play', speed: 3, task: 'Play.' }] } as unknown as WorkflowPlan })).rejects.toThrow('steps[0].speed');
  const run = await owner.call('workflows.start', { threadId, requestId: 'speeds', plan: { name: 'Speeds', steps: [
    { id: 'quick', model: 'echo', speed: ' Fast ', task: 'Play quickly.' },
    { id: 'own', speed: 'priority', after: ['quick'], task: 'Play on this model.' },
    { id: 'plain', speed: null, after: ['own'], task: 'Play again.' },
    { id: 'gate', after: ['plain'], task: 'Hold the run.' },
    { id: 'late', speed: 'fast', after: ['gate'], task: 'Play after the tiers are gone.' },
  ] } });
  // The run stores the tier id, trimmed and resolved, not what the plan spelled.
  expect(run.plan.steps.map(step => step.speed ?? null)).toEqual(['priority', 'priority', null, null, 'priority']);
  await waitFor(() => held.size === 1);
  const extended = await owner.call('workflows.extend', { threadId, runId: run.id, requestId: 'more', steps: [{ id: 'added', speed: 'FAST', after: ['gate'], task: 'Play, added later.' }] });
  expect(extended.plan.steps.at(-1)!.speed).toBe('priority');
  // A restart drops what the agent listed: the steps checked before it still launch on their tier.
  delete echo.speeds;
  await expect(owner.call('workflows.check', { threadId, plan: { name: 'New', steps: [{ id: 'play', speed: 'priority', task: 'Play.' }] } })).rejects.toThrow('echo/echo offers no speed tier; leave speed out');
  [...held.values()][0]!('held');
  const done = await settled(h, threadId, run.id, ['done']);
  const speeds = Object.fromEntries(done.nodes.map(node => [node.id, node.instances[0]!.speed ?? null]));
  expect(speeds).toEqual({ quick: 'priority', own: 'priority', plain: null, gate: null, late: 'priority', added: 'priority' });
  expect(Object.fromEntries(done.nodes.map(node => [node.id, h.core.threads.require(node.instances[0]!.threadId!).speed ?? null]))).toEqual(speeds);
});
