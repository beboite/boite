import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG, extractJson, RpcErrorCode } from '@boite/contracts';
import type { DelegationConfig, Turn, WorkflowPlan, WorkflowRun } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { runCli } from '../src/cli.ts';
import { startServer } from '../src/server.ts';
import { assertIdleFamily } from '../src/threads/completion.ts';
import { HANDOFF } from '../src/threads/handoff.ts';
import { AGENT_ENV } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

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

test('workflow usage includes every reported turn per execution while other steps still run', async () => {
  const { held } = scripted(ctx => taskOf(ctx.prompt) === 'Wait.' ? { hold: true } : 'Done.');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, requestId: 'usage', plan: { name: 'Usage', steps: [
    { id: 'quick', profile: 'fast', task: 'Quick.' },
    { id: 'slow', profile: 'fast', task: 'Wait.' },
  ] } });
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.status === 'done');
  const running = await owner.call('workflows.get', { threadId, runId: run.id });
  expect(running.status).toBe('running');
  expect(running.nodes[0]!.instances[0]).toHaveProperty('usage', running.usage);
  expect(running.usage.inputTokens).toBe(10);
  expect(running.nodes[1]!.instances[0]).toHaveProperty('usage', null);

  // Cache tokens and an earlier turn of the same execution must survive the sum.
  const childId = running.nodes[0]!.instances[0]!.threadId!;
  const turn = h.core.journal.listTurns(childId)[0]!;
  h.core.journal.putTurn({ ...turn, id: `${turn.id}-earlier`, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 30, costUsdEquivalent: 0.01 } });
  held.get(running.nodes[1]!.instances[0]!.threadId!)!('Done.');
  const done = await settled(h, threadId, run.id);
  expect(done.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 200, cacheWriteTokens: 30, costUsdEquivalent: 0.01 });
  expect(done.nodes[0]!.instances[0]).toHaveProperty('usage', { inputTokens: 110, outputTokens: 25, cacheReadTokens: 200, cacheWriteTokens: 30, costUsdEquivalent: 0.01 });
  expect(done.nodes[1]!.instances[0]).toHaveProperty('usage.inputTokens', 10);
});

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
  // A done run puts its steps' conversations away as done.
  const steps = done.nodes.flatMap(n => n.instances).map(i => h.core.threads.require(i.threadId!));
  expect(steps.map(step => [step.archived, step.doneAt != null])).toEqual(steps.map(() => [true, true]));
  // Its parent writing to one brings it back for that work, then puts it away again.
  await owner.call('delegation.send', { threadId, toThreadId: steps[0]!.id, text: 'One more look', requestId: 'step-more' });
  await waitFor(() => h.core.journal.listTurns(steps[0]!.id).length === 2 && h.core.threads.require(steps[0]!.id).archived);
  expect(h.core.journal.listTurns(steps[0]!.id).at(-1)!.status).toBe('done');
  // A retried start is the same run.
  expect((await owner.call('workflows.start', { threadId, plan: REVIEW, requestId: 'review-1' })).id).toBe(run.id);
  expect(await thrown(owner.call('workflows.start', { threadId, plan: { ...REVIEW, name: 'Other' }, requestId: 'review-1' }))).toThrow('different content');
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
  expect(await thrown(bad({ name: 'x', steps: [] }))).toThrow('steps: expected at least one step');
  expect(await thrown(bad({ name: 'x', steps: [{ id: 'a', profile: 'nope', task: 't' }] }))).toThrow('steps[0].profile: "nope" is not a profile of this thread; expected one of fast, reviewer, or leave profile out');
  expect(await thrown(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: 'use {{b.x}}' }, { id: 'b', profile: 'fast', task: 'use {{a}}' }] }))).toThrow('cycle a -> b -> a');
  expect(await thrown(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: '{{item}}' }] }))).toThrow('{{item}} exists only in a step with forEach');
  expect(await thrown(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: 't', output: { n: 'integer' } }] }))).toThrow('steps[0].output.n');
  expect(await thrown(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: 't', when: { path: 'a.b', equals: 1, empty: true } }] }))).toThrow('exactly one of');
  expect(await thrown(bad({ name: 'x', limits: { maxSteps: 500 }, steps: [{ id: 'a', profile: 'fast', task: 't' }] }))).toThrow('limits.maxSteps: expected an integer from 1 to 64');
  expect(await thrown(bad({ name: 'x', steps: [{ id: 'a', profile: 'fast', task: 't', context: { drop: ['memory'] } }] }))).toThrow('steps[0].context.drop: expected a list of instructions, guides, mcp, hooks');
  expect(await bad(REVIEW)).toEqual({ levels: [['scan'], ['review'], ['fix'], ['report']] });
});

const FENCED_TEXT = { text: 'Keep ``` inside the JSON string.' };
const fencedOutput = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```';

test.each([
  ['backticks inside a JSON string', fencedOutput(FENCED_TEXT), { value: FENCED_TEXT }],
  ['U+2028 around backticks inside a JSON string', fencedOutput({ text: 'Before\u2028```\u2028after' }), { value: { text: 'Before\u2028```\u2028after' } }],
  ['U+2029 around backticks inside a JSON string', fencedOutput({ text: 'Before\u2029```\u2029after' }), { value: { text: 'Before\u2029```\u2029after' } }],
  ['CRLF and an indented closing fence', '```json \r\n' + JSON.stringify(FENCED_TEXT) + '\r\n  ``` \t\r\n', { value: FENCED_TEXT }],
  ['an opening after prose and an extra backtick', 'Answer: ````json\t\n' + JSON.stringify(FENCED_TEXT) + '\n```', { value: FENCED_TEXT }],
  ['four-backtick fences around JSON containing backticks', '````json\n' + JSON.stringify(FENCED_TEXT) + '\n````', { value: FENCED_TEXT }],
  ['raw JSON', JSON.stringify(FENCED_TEXT), { value: FENCED_TEXT }],
  ['the last valid block', fencedOutput({ text: 'Earlier' }) + '\nThen:\n' + fencedOutput(FENCED_TEXT), { value: FENCED_TEXT }],
  ['an invalid final block', fencedOutput(FENCED_TEXT) + '\n```json\n{"text":}\n```', { value: FENCED_TEXT }],
  ['an unterminated final block', fencedOutput(FENCED_TEXT) + '\n```json\n{"text":', { value: FENCED_TEXT }],
  ['non-overlapping blocks', '```json\ninvalid\n' + fencedOutput(FENCED_TEXT), null],
  ['malformed JSON', '```json\n{"text":}\n```', null],
] as const)('workflow JSON extraction: %s', (_name, answer, expected) => {
  expect(extractJson(answer)).toEqual(expected);
});

test('workflow JSON extraction finishes on repeated unterminated fences', async () => {
  const { h, threadId } = await setup();
  const module = new URL('../../contracts/src/workflow-plan.ts', import.meta.url).href;
  const program = `
    import { extractJson } from ${JSON.stringify(module)};
    const fence = ${JSON.stringify('```')};
    const answers = [
      fence + '\\n' + (fence + '\\na').repeat(500_000),
      fence + 'json\\n' + ' '.repeat(500_000) + 'x\\n',
      fence + '\\n' + (fence + '\\t').repeat(500_000),
    ];
    console.log(JSON.stringify(answers.map(extractJson)));
  `;
  const child = h.core.procs.spawn(threadId, process.execPath, ['--eval', program], { agentRoot: false });
  const output = new Response(child.proc.stdout).text();
  const errors = new Response(child.proc.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exit: number | null;
  try {
    // A generous liveness bound, not a benchmark: the old backtracking takes minutes on this input.
    exit = await Promise.race([child.exited, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
  } finally {
    clearTimeout(timer);
    h.core.procs.killTree(threadId);
    await child.exited;
  }
  expect(exit).toBe(0);
  expect(await errors).toBe('');
  expect(await output).toBe('[null,null,null]\n');
}, 20_000);

test('fenced workflow output preserves backticks in a JSON string without a correction', async () => {
  const output = { text: 'Keep \u2028```\u2028 and \u2029```\u2029 inside the JSON string.' };
  const { prompts } = scripted(ctx => taskOf(ctx.prompt) === 'Produce text.'
    ? fencedOutput(output)
    : 'noted');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', {
    threadId, requestId: 'backtick-output', plan: { name: 'Backtick output', steps: [
      { id: 'source', profile: 'fast', task: 'Produce text.', output: { text: 'string' } },
      { id: 'use', profile: 'fast', task: 'Use {{source.text}}' },
    ] },
  });
  const done = await settled(h, threadId, run.id);
  expect([done.status, done.error]).toEqual(['done', null]);
  const source = done.nodes[0]!.instances[0]!;
  expect(source.output).toEqual(output);
  expect(source.attempts).toBe(1);
  expect(h.core.journal.listTurns(source.threadId!)).toHaveLength(1);
  expect(prompts.some(prompt => prompt.prompt.includes('does not match this workflow step'))).toBe(false);
  const use = done.nodes[1]!.instances[0]!;
  const expectedTask = `Use ${output.text}`;
  expect(use.task).toBe(expectedTask);
  expect(prompts.filter(prompt => prompt.threadId === use.threadId).map(prompt => taskOf(prompt.prompt))).toEqual([expectedTask]);
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
    expect(await thrown(step.call('workflows.output', { threadId: stepThread, value: { items: ['1'] } }))).toThrow('output.items[0]: expected a number');
    expect(await step.call('workflows.output', { threadId: stepThread, value: { items: [1, 2, 3, 4] } })).toEqual({ runId: run.id, step: 'list' });
    expect(await thrown(step.call('workflows.start', { threadId: stepThread, plan, requestId: 'nested' }))).toThrow('cannot start a workflow');
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
    expect(await thrown(agent.call('workflows.check', { threadId, plan: { name: 'x', steps: [{ id: 'a', profile: 'fast', task: 't' }] } }))).toThrow('none is configured: leave profile out');
  } finally { agent.close(); }
});

test('a failed turn of the conversation leaves its run going, and the result still reaches it', async () => {
  let fail = true;
  const { held, prompts } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : fail ? { status: 'error' } : 'parent acknowledged');
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Two', steps: [{ id: 'a', task: 'a' }, { id: 'b', task: 'b {{a}}' }] }, requestId: 'two' });
  await waitFor(() => held.size === 1);
  // A provider error on the conversation is not the owner's Stop: nothing pauses.
  await owner.call('turns.start', { threadId, prompt: 'Carry on' });
  await waitFor(() => h.core.threads.require(threadId).status === 'error');
  expect(h.core.workflows.get(threadId, run.id).status).toBe('running');
  expect(h.core.delegation.config(threadId).paused).toBe(false);
  fail = false;
  [...held.values()][0]!('A done');
  await waitFor(() => held.size === 1 && h.core.workflows.get(threadId, run.id).nodes[1]!.instances.length === 1);
  [...held.values()][0]!('B done');
  expect((await settled(h, threadId, run.id)).status).toBe('done');
  await waitFor(() => prompts.some(p => p.threadId === threadId && p.prompt.includes('B done')));
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
    expect(await thrown(agent.call('workflows.control', { threadId, runId: run.id, action: 'resume' }))).toThrow('owner');
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
    // Registered after the workflows' own committed observer: the close begins once the correction is decided.
    const off = h.core.bus.onCommitted((name, payload) => {
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
    // A pause its agent may lift: a crash holds the run, it does not take it from the agent.
    expect(record.pausedBy).toBe('restart');
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

test('an agent changes only the runs it started, resumes its own pause, and the owner\'s once the owner wrote again', async () => {
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const mine = await owner.call('workflows.start', { threadId, plan: { name: 'Mine', steps: [{ id: 'a', profile: 'fast', task: 'a' }] }, requestId: 'mine' });
    await waitFor(() => held.size === 1);
    for (const action of ['pause', 'stop', 'retry'] as const) {
      expect(await thrown(agent.call('workflows.control', { threadId, runId: mine.id, action }))).toThrow('the user started this run');
    }
    expect(await thrown(agent.call('workflows.extend', { threadId, runId: mine.id, steps: [{ id: 'b', profile: 'fast', task: 'b' }], requestId: 'more' }))).toThrow('the user started this run');
    await owner.call('workflows.control', { threadId, runId: mine.id, action: 'stop' });
    const theirs = await agent.call('workflows.start', { threadId, plan: { name: 'Theirs', steps: [{ id: 'a', profile: 'fast', task: 'a' }] }, requestId: 'theirs' });
    await waitFor(() => held.size === 1);
    // Its own pause is its to lift.
    expect(await agent.call('workflows.control', { threadId, runId: theirs.id, action: 'pause' })).toMatchObject({ status: 'paused', pausedBy: 'agent' });
    expect((await agent.call('workflows.control', { threadId, runId: theirs.id, action: 'resume' })).status).toBe('running');
    // Its stop of the team while the run goes on is its own too, and the owner saving settings keeps it so.
    await agent.call('delegation.stop', { threadId });
    expect(h.core.delegation.config(threadId)).toMatchObject({ paused: true, pausedBy: 'agent' });
    await owner.call('delegation.configure', { threadId, config: { ...h.core.delegation.config(threadId), anyModel: false } });
    expect(h.core.delegation.config(threadId)).toMatchObject({ paused: true, pausedBy: 'agent', anyModel: false });
    expect((await agent.call('delegation.resume', { threadId })).unpaused).toBe(true);
    // The owner's waits for the owner's next word, for a resume and for a retry alike.
    expect(await owner.call('workflows.control', { threadId, runId: theirs.id, action: 'pause' })).toMatchObject({ status: 'paused', pausedBy: 'owner' });
    expect(await thrown(agent.call('workflows.control', { threadId, runId: theirs.id, action: 'resume' }))).toThrow('once they write to the conversation again');
    expect(await thrown(agent.call('workflows.control', { threadId, runId: theirs.id, action: 'retry' }))).toThrow('once they write to the conversation again');
    await owner.call('turns.start', { threadId, prompt: 'Carry on with the workflow' });
    const resumed = await agent.call('workflows.control', { threadId, runId: theirs.id, action: 'resume' });
    expect(resumed.status).toBe('running');
    expect(resumed.pausedBy).toBeUndefined();
    expect((await agent.call('workflows.control', { threadId, runId: theirs.id, action: 'stop' })).status).toBe('stopped');
  } finally { agent.close(); }
});

test('a step sent back to work in its own conversation counts for its run, which then finishes', async () => {
  const { held, prompts } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Media', steps: [{ id: 'media', profile: 'fast', task: 'Make the titled assets' }, { id: 'ship', profile: 'fast', after: ['media'], task: 'Ship {{media}}' }] }, requestId: 'media' });
  await waitFor(() => held.size === 1);
  const step = run.nodes[0]!.instances[0]!.threadId!;
  // The user stops the step in its conversation: the run fails with it.
  await owner.call('turns.stop', { threadId: step });
  expect((await settled(h, threadId, run.id)).status).toBe('failed');
  // Then tells it to carry on there. Before, that answer stayed in the step's conversation and the run stayed failed.
  await owner.call('turns.start', { threadId: step, prompt: 'Carry on, with the title "you are lost"' });
  await waitFor(() => h.core.workflows.get(threadId, run.id).status === 'running');
  expect(h.core.workflows.get(threadId, run.id).nodes[0]!.instances[0]).toMatchObject({ status: 'running', error: null });
  held.get(step)!('Assets done, titled "you are lost"');
  await waitFor(() => held.size === 1);
  const ship = prompts.at(-1)!;
  expect(ship.threadId).not.toBe(step);
  expect(taskOf(ship.prompt)).toBe('Ship Assets done, titled "you are lost"');
  [...held.values()][0]!('Shipped');
  expect((await settled(h, threadId, run.id)).status).toBe('done');
  // The root hears of the finished run too, not only of the failure.
  await waitFor(() => h.core.workflows.get(threadId, run.id).delivered);
});

/** A run's step and a subagent at work when an update's handoff stops the core; the core is closed after. */
async function cutByHandoff() {
  const resumed = (prompt: string) => prompt.includes('Boite restarted') || prompt.includes('Try this workflow step again') || prompt.includes('Continue your task');
  const { held, prompts } = scripted(ctx => ctx.thread.parentThreadId && !resumed(ctx.prompt) ? { hold: true } : 'resumed and done');
  let stops = 0;
  const h = await startTestCore({ onShutdown: () => { stops += 1; } }); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Parent');
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Long', steps: [{ id: 'a', task: 'a' }] }, requestId: 'long' });
  const child = await owner.call('delegation.spawn', { threadId, task: 'Write the parser', requestId: 'parser' });
  await waitFor(() => held.size === 2);
  const step = run.nodes[0]!.instances[0]!.threadId!;
  const response = await fetch(`${h.url}/shutdown-for-update?pid=${process.pid}`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } });
  expect(response.status).toBe(202);
  await waitFor(() => stops === 1);
  // Before, the run failed with a stopped step and the parent got a "stopped" result for the child.
  expect(h.core.workflows.get(threadId, run.id).status).toBe('running');
  expect(h.core.workflows.get(threadId, run.id).nodes[0]!.instances[0]).toMatchObject({ status: 'waiting', error: 'Interrupted by a core restart' });
  expect(h.core.delegation.get(threadId).messages.filter(letter => letter.origin === 'result')).toHaveLength(0);
  owner.close();
  await h.core.drain();
  await h.server.stop();
  await h.core.close();
  return { h, threadId, run, child: child.thread.id, step, prompts };
}

test('a restart handoff cuts steps and subagents without failing them, and the next core continues both', async () => {
  const { h, threadId, run, child, step, prompts } = await cutByHandoff();
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  const server = startServer({ core: next, host: '127.0.0.1', port: 0 });
  try {
    expect(next.delegation.config(threadId).paused).toBe(false);
    await waitFor(() => next.workflows.get(threadId, run.id).status === 'done', 5000);
    expect(prompts.filter(p => p.threadId === step).at(-1)!.prompt).toContain('Interrupted by a core restart');
    await waitFor(() => next.journal.listTurns(child).at(-1)?.status === 'done', 5000);
    expect(next.journal.listTurns(child).at(-1)!.execution?.operation).toBe('resume');
    expect(prompts.filter(p => p.threadId === child).at(-1)!.prompt).toContain('Write the parser');
    expect(next.journal.getSetting('delegation-restart-cut')).toBeFalsy();
  } finally {
    await server.stop();
    await next.close();
  }
});

test('a handoff older than an hour continues nothing: the team and the run wait, held by the restart', async () => {
  const { h, threadId, run, child } = await cutByHandoff();
  const maxAge = HANDOFF.maxAgeMs;
  HANDOFF.maxAgeMs = -1;
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  HANDOFF.maxAgeMs = maxAge;
  const server = startServer({ core: next, host: '127.0.0.1', port: 0 });
  try {
    // Before, the cut child got a paid continuation anyway and its team showed no pause.
    expect(next.delegation.config(threadId)).toMatchObject({ paused: true, pausedBy: 'restart' });
    expect(next.workflows.get(threadId, run.id)).toMatchObject({ status: 'paused', pausedBy: 'restart' });
    expect(next.journal.getSetting('delegation-restart-cut')).toBeFalsy();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(next.journal.listTurns(child).at(-1)!.status).toBe('stopped');
    expect(next.delegation.resume(threadId, undefined, 'agent')).toEqual({ unpaused: true, agents: [child], runs: [] });
    // The owner started the run, so resuming it stays theirs.
    expect(next.delegation.resume(threadId, undefined, 'owner')).toMatchObject({ unpaused: false, runs: [run.id] });
    await waitFor(() => next.workflows.get(threadId, run.id).status === 'done', 5000);
    await waitFor(() => next.journal.listTurns(child).at(-1)?.status === 'done', 5000);
  } finally {
    await server.stop();
    await next.close();
  }
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

test('a failed step stops what never launched and is told to the parent at once, and a retry past an archived conversation opens a new one', async () => {
  const { held, prompts } = scripted(ctx => !ctx.thread.parentThreadId ? 'noted' : taskOf(ctx.prompt) === 'x' ? '```json\n{"items": [1, 2, 3, 4]}\n```' : { hold: true });
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
  // The parent hears of the failure now, once, not when the last running step ends.
  const told = () => prompts.filter(p => p.threadId === threadId && p.prompt.startsWith('Boite workflow step failed'));
  await waitFor(() => told().length === 1);
  expect(told()[0]!.prompt).toContain(`"failed":[{"step":"each","item":"1","status":"failed"`);
  expect(told()[0]!.prompt).toContain('"running":["each (2)"]');
  expect(told()[0]!.prompt).toContain(`boite workflow retry ${run.id} each`);
  await waitFor(() => h.core.workflows.get(threadId, run.id).failuresNoticed?.length === 1);
  held.get(second)!('Two done.');
  const failed = await settled(h, threadId, run.id);
  expect(failed.status).toBe('failed');
  await waitFor(() => prompts.some(p => p.threadId === threadId && p.prompt.includes('Boite workflow failed')));
  expect(told()).toHaveLength(1);
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
  expect(retried[0]!.usage?.inputTokens).toBe(10);
  expect(retried.map(i => i.status)).toEqual(['running', 'done', 'running', 'waiting']);
  // The archived conversation speaks for nothing once the step moved on.
  const stale = await connect(h.url, h.core.agents.tokenFor(first));
  try {
    expect(await thrown(stale.call('workflows.output', { threadId: first, value: null }))).toThrow('is not running');
  } finally { stale.close(); }
  for (const finish of [...held.values()]) finish('ok');
  await waitFor(() => held.size === 1);
  for (const finish of [...held.values()]) finish('ok');
  const done = await settled(h, threadId, run.id);
  expect(done.status).toBe('done');
  expect(done.nodes[1]!.instances[0]!.usage?.inputTokens).toBe(20);
});

test('a step that fails before it has any execution is told to the parent while another step runs', async () => {
  const { held, prompts } = scripted(ctx => !ctx.thread.parentThreadId ? 'noted' : taskOf(ctx.prompt) === 'list' ? '```json\n{"items": "not a list"}\n```' : { hold: true });
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Open', steps: [
    { id: 'long', profile: 'fast', task: 'long' },
    { id: 'list', profile: 'fast', task: 'list', output: { items: 'any' } },
    { id: 'each', profile: 'fast', forEach: 'list.items', task: 'do {{item}}' },
  ] }, requestId: 'open' });
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[2]!.status === 'failed');
  expect(h.core.workflows.get(threadId, run.id).status).toBe('running');
  // Before, a step with no execution was never told: the parent waited for "long" to end.
  await waitFor(() => prompts.some(p => p.threadId === threadId && p.prompt.startsWith('Boite workflow step failed') && p.prompt.includes('"step":"each","status":"failed"')));
  for (const finish of [...held.values()]) finish('ok');
  expect((await settled(h, threadId, run.id)).status).toBe('failed');
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

test('Mark done waits for a running run and stops a paused one, which expiry still keeps', async () => {
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Two', steps: [{ id: 'a', profile: 'fast', task: 'a' }, { id: 'b', profile: 'fast', task: 'b {{a}}' }] }, requestId: 'done' });
  await waitFor(() => held.size === 1);
  expect(await owner.call('threads.archive', { threadId, onlyIfIdle: true }).catch(error => error)).toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
  await owner.call('workflows.control', { threadId, runId: run.id, action: 'pause' });
  [...held.values()][0]!('A done');
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.status === 'done' && h.core.threads.require(threadId).status === 'idle');
  // The Curio Shop case: a run paused days ago refused Done with "a workflow is still running".
  expect(() => assertIdleFamily(h.core, threadId)).toThrow('a workflow is still running');
  expect((await owner.call('threads.archive', { threadId, onlyIfIdle: true })).archived).toBe(true);
  expect(h.core.workflows.get(threadId, run.id)).toMatchObject({ status: 'stopped', error: 'The thread was archived.' });
  await Bun.sleep(20);
  expect(held.size).toBe(0);
});

test('an archive that rolls back leaves its run paused, and the committed one stops it once', async () => {
  const { held } = scripted(ctx => ctx.thread.parentThreadId ? { hold: true } : 'noted');
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Two', steps: [{ id: 'a', profile: 'fast', task: 'a' }, { id: 'b', profile: 'fast', task: 'b {{a}}' }] }, requestId: 'rollback' });
  await waitFor(() => held.size === 1);
  await owner.call('workflows.control', { threadId, runId: run.id, action: 'pause' });
  [...held.values()][0]!('A done');
  await waitFor(() => h.core.workflows.get(threadId, run.id).nodes[0]!.status === 'done' && h.core.threads.require(threadId).status === 'idle');
  // Stopping a run also stops its processes and shared jobs, which no rollback brings back.
  const stopRoot = h.core.workflows.stopRoot.bind(h.core.workflows);
  let stops = 0;
  h.core.workflows.stopRoot = (rootId, reason) => { stops += 1; return stopRoot(rootId, reason); };
  const announce = h.core.projects.announce;
  h.core.projects.announce = () => { throw new Error('injected failure after the thread was written'); };
  try { expect(() => h.core.threads.archive(threadId, true)).toThrow('injected failure'); }
  finally { h.core.projects.announce = announce; }
  expect(h.core.threads.require(threadId).archived).toBe(false);
  expect(stops).toBe(0);
  expect(h.core.workflows.get(threadId, run.id).status).toBe('paused');
  h.core.threads.archive(threadId, true);
  expect(stops).toBe(1);
  expect(h.core.workflows.get(threadId, run.id)).toMatchObject({ status: 'stopped', error: 'The thread was archived.' });
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
    expect(await thrown(agent.call('workflows.templates.save', { threadId, name: 'Review', plan: { ...REVIEW, steps: REVIEW.steps.slice(0, 1) } }))).toThrow('a template named "Review" already exists');
    expect(await thrown(agent.call('workflows.templates.save', { threadId, name: 'Other', plan: REVIEW, templateId: saved.id }))).toThrow('already exists');
    expect((await owner.call('workflows.templates.save', { threadId, name: 'Review', plan: { ...REVIEW, steps: REVIEW.steps.slice(0, 1) } })).id).toBe(saved.id);
  } finally { agent.close(); }
});

test('a step names its model and reasoning level, and a level the model lacks is refused before anything starts', async () => {
  scripted(() => 'done');
  const { h, owner, threadId } = await setup();
  const bad: WorkflowPlan = { name: 'Bad', steps: [{ id: 'think', model: 'echo/echo', effort: 'ultra', task: 'Think.' }] };
  expect(await thrown(owner.call('workflows.check', { threadId, plan: bad }))).toThrow('steps[0] (think)');
  expect(await thrown(owner.call('workflows.check', { threadId, plan: { name: 'Missing', steps: [{ id: 'think', model: 'no-such-model', task: 'Think.' }] } }))).toThrow('no installed model');
  const run = await owner.call('workflows.start', { threadId, requestId: 'routes', plan: { name: 'Routes', steps: [
    { id: 'quick', model: 'echo', effort: 'low', task: 'Look quickly.' },
    { id: 'plain', after: ['quick'], task: 'Look again.', context: { preset: 'neutral', rules: 'No house style.' } },
  ] } });
  const done = await settled(h, threadId, run.id, ['done']);
  const [quick, plain] = done.nodes.map(node => node.instances[0]!);
  // A step names its context mode the way a spawn does; the step without one gets the whole setup.
  expect(h.core.threads.require(quick!.threadId!).contextMode).toBeUndefined();
  expect(h.core.threads.require(plain!.threadId!).contextMode).toMatchObject({ label: 'neutral', hooks: false, rules: 'No house style.' });
  expect([quick!.providerId, quick!.model, quick!.effort]).toEqual(['echo', 'echo', 'low']);
  expect(h.core.threads.require(quick!.threadId!).effort).toBe('low');
  expect(plain!.effort).toBe(h.core.threads.require(threadId).effort);
});

test('retrying one of two failed steps names the other, changes nothing, and a run retry reopens both', async () => {
  const { held } = scripted(ctx => !ctx.thread.parentThreadId ? 'noted' : { hold: true });
  const { h, owner, threadId } = await setup();
  const run = await owner.call('workflows.start', { threadId, plan: { name: 'Pair', limits: { maxConcurrent: 2 }, steps: [
    { id: 'left', profile: 'fast', task: 'left' },
    { id: 'right', profile: 'fast', task: 'right' },
  ] }, requestId: 'pair' });
  await waitFor(() => held.size === 2);
  for (const finish of [...held.values()]) finish('', 'error');
  const failed = await settled(h, threadId, run.id);
  expect(failed.nodes.map(node => node.status)).toEqual(['failed', 'failed']);

  expect(await thrown(owner.call('workflows.control', { threadId, runId: run.id, action: 'retry', stepId: 'left' })))
    .toThrow('the run stays stopped while right has failed; retry that step too, or retry the whole run without naming a step');
  const unchanged = h.core.workflows.get(threadId, run.id);
  expect([unchanged.status, ...unchanged.nodes.map(node => node.status)]).toEqual(['failed', 'failed', 'failed']);

  await owner.call('workflows.control', { threadId, runId: run.id, action: 'retry' });
  await waitFor(() => held.size === 2);
  expect(h.core.workflows.get(threadId, run.id).nodes.map(node => node.status)).toEqual(['running', 'running']);
  for (const finish of [...held.values()]) finish('ok');
  expect((await settled(h, threadId, run.id)).status).toBe('done');
});
