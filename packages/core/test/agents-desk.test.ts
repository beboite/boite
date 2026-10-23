import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AgentProfile, AgentWatch, LinkedPullRequest, PullRequestWatch, ThreadSummary } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { STALL_MS, WATCHES_MAX } from '../src/agents/projects.ts';
import { agentContext } from '../src/agents/context.ts';
import { EVENT_HEADER, NOTICES_PER_HOUR } from '../src/agents/runtime.ts';
import { costing, makeAgent, settled, turnsOf } from './agent-fixture.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const DAY = 24 * 3_600_000;
let h: TestCore;
let owner: CoreClient;
let agent: AgentProfile;
let self: string;
let worker: string;
let project: string;
let accountId: string;
const restores: (() => void)[] = [];
const held: (() => void)[] = [];
const prompts = new Map<string, string[]>();

/**
 * The echo driver for these scenarios. The agent's own event turns answer
 * quietly; a prompt with HOLD runs a tool and stays running until `release`;
 * other threads finish their goal at once.
 */
function drive(): void {
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const own = Boolean(ctx.thread.agentSessionId);
    const id = ctx.emit.startMessage('assistant');
    const hold = ctx.prompt.includes('HOLD');
    if (hold) ctx.emit.part(id, 0, { type: 'tool', toolId: 'tool-1', name: 'Bash', input: { command: 'bun test', description: 'Run the core tests' }, output: null, status: 'running' });
    else ctx.emit.part(id, 0, { type: 'text', text: own ? (ctx.prompt.includes(EVENT_HEADER) || ctx.prompt.includes('You were just created') ? '[quiet] read the events' : 'Tests pass.') : 'Done.\n[BOITE_GOAL_COMPLETE]' });
    if (!hold) ctx.emit.complete(id, 'complete');
    const result: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: costing(own ? 0.25 : 0) };
    const done = hold
      ? new Promise<TurnResult>(resolve => held.push(() => { ctx.emit.part(id, 1, { type: 'text', text: 'Tests pass.' }); ctx.emit.complete(id, 'complete'); resolve(result); }))
      : Promise.resolve(result);
    return { done, stop() {} };
  } }));
}
const release = () => { for (const done of held.splice(0)) done(); };

beforeEach(async () => {
  prompts.clear();
  h = await startTestCore(); owner = await h.connect();
  ({ threadId: worker, accountId } = await echoThread(h, owner, 'Worker'));
  project = h.core.threads.require(worker).projectId!;
  drive();
  ({ agent, threadId: self } = await makeAgent(h, owner, { projectIds: [project] }));
});
afterEach(async () => {
  release();
  await h.stop();
  for (const restore of restores.splice(0)) restore();
});

const facts = () => h.core.agentRuntime.facts(agent.id);
/** The desk as the core builds it for `agents.snapshot`. */
const watches = (): AgentWatch[] => h.core.workforce.snapshot().watches;
const watchOf = (threadId: string) => watches().find(w => w.threadId === threadId);
const lines = () => h.core.journal.listMessages(self).filter(m => m.role === 'system').flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : []));
/** Makes the waiting facts due now, the way their delay running out would. */
const hurry = () => {
  const pending = (h.core.agentRuntime as unknown as { pending: Map<string, { facts: { notBefore: number }[] }> }).pending.get(agent.id);
  for (const fact of pending?.facts ?? []) fact.notBefore = 0;
};
const thread = (title: string) => owner.call('threads.create', { projectId: project, providerId: 'echo', accountId, title });
/** `boite ...` from the agent's own thread. */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env: { BOITE_THREAD_ID: self, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(self) }, cwd: h.dataDir });
  await Bun.sleep(5);
  return { code, out, err };
}

test('the desk holds a thread it started, one entrusted to it and one it watches, each read from the thread', async () => {
  h.core.workforce.setLimits({ paused: true });
  const started = await cli(['thread', 'new', 'test', 'Write the release notes']);
  expect(started.err).toBe('');
  const startedId = /thread: (\S+)/.exec(started.out)![1]!;
  const entrusted = (await thread('Fix the login')).id;
  await owner.call('agents.entrust', { threadId: entrusted, agentId: agent.id, objective: 'Make the login work' });
  const review = (await thread('Review the docs')).id;
  expect((await cli(['agent', 'watch', review])).code).toBe(0);
  await owner.call('turns.start', { threadId: review, prompt: 'Read the docs' });
  await waitFor(() => settled(h, startedId) && settled(h, entrusted) && settled(h, review) && turnsOf(h, review).length === 1);

  const rows = (await owner.call('agents.snapshot', {})).watches;
  expect(rows.map(w => [w.threadId, w.origin])).toEqual(expect.arrayContaining([[startedId, 'started'], [entrusted, 'entrusted'], [review, 'followed']]));
  expect(rows.find(w => w.threadId === startedId)).toMatchObject({ agentId: agent.id, title: 'Write the release notes', projectId: project, state: 'idle', stalledSince: null, pullRequest: null, question: null });

  // A question in a watched thread makes it need the user, answerable from the desk with its options.
  const asker = await connect(h.url, h.core.agents.tokenFor(review));
  try {
    const { questionId } = await asker.call('questions.ask', { threadId: review, text: 'Publish now?', options: ['Yes', 'No'] });
    await waitFor(() => (watchOf(review))?.state === 'needs-you');
    expect((watchOf(review))!.question).toEqual({ id: questionId, text: 'Publish now?', options: ['Yes', 'No'] });
    expect(agentContext(h.core, agent).text).toContain(`- "Review the docs" (${review}) in test: needs the user`);
  } finally { asker.close(); }

  // Open threads come first; a done one stays on the desk, below them.
  await owner.call('threads.archive', { threadId: startedId });
  const after = watches();
  expect(after.at(-1)!.threadId).toBe(startedId);
  expect(after.at(-1)!.state).toBe('archived');
  expect((await cli(['agent', 'unwatch', review])).code).toBe(0);
  expect((watches()).some(w => w.threadId === review)).toBe(false);
});

test('a follow stays past seven days while its thread is open and leaves a day after the thread is done; open follows stop at the cap', async () => {
  const desk = h.core.workforce.projects;
  desk.follow(agent.id, worker, 'followed');
  const key = `resident-follow:${agent.id}`;
  h.core.journal.setSetting(key, { [worker]: { at: Date.now() - 8 * DAY, origin: 'followed' } });
  expect(desk.follows(agent.id, worker)).toBe(true);
  expect((watchOf(worker))?.state).toBe('idle');

  h.core.threads.archive(worker, true, true);
  expect((watchOf(worker))?.state).toBe('done');
  const done = h.core.threads.require(worker);
  h.core.journal.putThread({ ...done, archivedAt: Date.now() - DAY - 60_000 });
  expect(desk.follows(agent.id, worker)).toBe(false);
  expect(watchOf(worker)).toBeUndefined();

  // The cap counts open threads only: a settled one stays its day whatever the count.
  const base = h.core.threads.require(worker);
  h.core.journal.putThread({ ...base, archivedAt: Date.now() });
  desk.follow(agent.id, worker, 'followed');
  const open: string[] = [];
  for (let i = 0; i <= WATCHES_MAX; i++) {
    const id = `thr_open${i}`;
    h.core.journal.putThread({ ...base, id, title: `Open ${i}`, archived: false, archivedAt: null, doneAt: null } as ThreadSummary);
    open.push(id);
    desk.follow(agent.id, id, 'followed');
  }
  const ids = desk.watchesOf(agent.id).map(w => w.threadId);
  expect(ids.filter(id => id.startsWith('thr_open'))).toHaveLength(WATCHES_MAX);
  expect(ids).not.toContain(open[0]);
  expect(ids).toContain(worker);
});

test('a desk thread silent for 20 minutes wakes the agent once per turn and shows since when', async () => {
  h.core.workforce.setLimits({ paused: true });
  h.core.workforce.projects.follow(agent.id, worker, 'followed');
  await owner.call('turns.start', { threadId: worker, prompt: 'HOLD and build' });
  await waitFor(() => h.core.threads.require(worker).status === 'running' && held.length === 1);
  const turnId = h.core.journal.runningTurn(worker)!.id;
  const desk = h.core.workforce.projects;
  desk.checkStalls(Date.now() + 60_000);
  expect(facts()).toEqual([]);

  const later = Date.now() + STALL_MS + 1000;
  desk.checkStalls(later);
  expect(facts().map(f => f.key)).toEqual([`stall:${turnId}`]);
  expect(facts()[0]!.text).toContain(`"Worker" (${worker}) has a running turn that produced nothing for 20 minutes`);
  expect((watchOf(worker))!.stalledSince).toBeNumber();
  expect(agentContext(h.core, agent).text).toContain(`(${worker}) in test: working, silent since`);

  // Once per turn: the next checks say nothing more, even after the facts were read.
  h.core.agentRuntime.filterFacts(agent.id, () => false);
  desk.checkStalls(later + STALL_MS);
  expect(facts()).toEqual([]);
  // A word from the turn ends the stall on the desk.
  h.core.bus.emit('message.delta', { threadId: worker, messageId: 'msg_x', partIndex: 0, text: 'still here' });
  await waitFor(() => (watchOf(worker))!.stalledSince === null);
  release();
  await waitFor(() => settled(h, worker));
  expect(h.core.journal.getSetting(`agents:stall:${worker}`)).toBeUndefined();
});

test('an entrusted goal that ends wakes the agent with an event turn naming the thread', async () => {
  const fixing = (await thread('Fix the login')).id;
  await owner.call('agents.entrust', { threadId: fixing, agentId: agent.id });
  await waitFor(() => facts().some(f => f.key.startsWith('goal:')));
  hurry();
  await waitFor(() => (prompts.get(self) ?? []).some(p => p.includes(`Entrusted thread "Fix the login" (${fixing}): goal done.`)) && settled(h, self), 10_000);
  const event = turnsOf(h, self).at(-1)!;
  expect(event.execution?.operation).toBe('event');
  expect(event.quiet).toBe(true);
});

test('a watched pull request whose checks start to fail, then merges, wakes the agent once for each', async () => {
  h.core.workforce.setLimits({ paused: true });
  h.core.workforce.projects.follow(agent.id, worker, 'started');
  const url = 'https://github.com/acme/app/pull/7';
  const linked: LinkedPullRequest = { url, repository: 'acme/app', number: 7, title: 'Login', state: 'OPEN', draft: false, head: 'login', base: 'main', headRepository: 'acme/app', checkedAt: Date.now() };
  h.core.journal.setSetting(`linked-pull-requests:${worker}`, [linked]);
  const updated = () => h.core.bus.emit('thread.updated', h.core.threads.require(worker));
  updated();
  expect((watchOf(worker))!.pullRequest).toEqual({ number: 7, url, state: 'open', checks: null });
  expect(facts()).toEqual([]);

  const watches = h.core.pullRequestWatches as unknown as { of: (threadId: string) => PullRequestWatch[] };
  const of = watches.of.bind(watches);
  watches.of = threadId => threadId !== worker ? of(threadId)
    : [{ url, repository: 'acme/app', number: 7, since: Date.now(), paused: null, seen: { checkedAt: Date.now(), head: 'abc1234', base: 'main', checks: { total: 3, running: 0, failed: 1 }, conflicting: false } }];
  try {
    updated(); updated();
    expect((watchOf(worker))!.pullRequest!.checks).toBe('failing');
    expect(facts().map(f => f.key)).toEqual([`pr-checks:${url}:abc1234`]);
    expect(facts()[0]!.text).toContain(`Checks fail on pull request #7 of "Worker" (${worker}) (1 of 3 failed on abc1234)`);
  } finally { watches.of = of; }

  await h.core.linkedPullRequests.observe(worker, url, 'MERGED');
  expect((watchOf(worker))!.pullRequest).toEqual({ number: 7, url, state: 'merged', checks: null });
  expect(facts().map(f => f.key)).toEqual([`pr-checks:${url}:abc1234`, `pr-merged:${url}`]);
  expect(facts()[1]!.text).toContain(`Pull request #7 of "Worker" (${worker}) was merged: ${url}.`);
  updated();
  expect(facts()).toHaveLength(2);
});

test('its status names the step it is on and what it waits on, and counts today\'s turns, wakes, quiet ones and spend', async () => {
  const status = () => h.core.workforce.snapshot().status[0]!;
  // The introduction was a quiet wake.
  expect(status()).toMatchObject({ state: 'idle', activity: null, last: null, today: { turns: 1, wakes: 1, quiet: 1, costUsd: 0.25 } });
  await owner.call('turns.start', { threadId: self, prompt: 'HOLD and run the tests' });
  await waitFor(() => status().activity === 'Run the core tests');
  expect(status().state).toBe('working');
  release();
  await waitFor(() => settled(h, self));
  const after = status();
  expect(after).toMatchObject({ state: 'idle', activity: null, today: { turns: 2, wakes: 1, quiet: 1, costUsd: 0.5 } });
  expect(after.last?.text).toBe('Tests pass.');

  const asker = await connect(h.url, h.core.agents.tokenFor(self));
  try {
    await asker.call('questions.ask', { threadId: self, text: 'Deploy now?\nIt takes ten minutes.', options: ['Yes', 'No'] });
    await waitFor(() => status().state === 'waiting');
    expect(status().activity).toBe('Waiting for your answer: Deploy now?');
  } finally { asker.close(); }
});

test('a dropped fact leaves a line in the agent\'s thread naming it, up to ten an hour', async () => {
  h.core.workforce.setLimits({ paused: true });
  const fact = (i: number, text = `"Worker" (thr_w${i}) turn ${i} done.`) => h.core.agentRuntime.fact(agent.id, { key: `turn:${i}`, text });
  // The size cap: an event turn holds 16,000 characters, the oldest fact gives way.
  expect(fact(0, `"Big" (thr_big) wrote a lot.\n${'x'.repeat(9000)}`)).toBe(true);
  expect(fact(1, `"Bigger" (thr_bigger) wrote more.\n${'y'.repeat(9000)}`)).toBe(true);
  expect(facts().map(f => f.key)).toEqual(['turn:1']);
  expect(lines()).toContain('Event dropped to keep the next wake under 16000 characters. "Big" (thr_big) wrote a lot.');

  // The hourly cap.
  for (let i = 2; i < NOTICES_PER_HOUR; i++) expect(fact(i)).toBe(true);
  expect(fact(NOTICES_PER_HOUR)).toBe(false);
  expect(lines()).toContain(`Event dropped: more than ${NOTICES_PER_HOUR} arrived this hour. "Worker" (thr_w${NOTICES_PER_HOUR}) turn ${NOTICES_PER_HOUR} done.`);
  for (let i = 1; i <= 12; i++) fact(NOTICES_PER_HOUR + i);
  const dropped = lines().filter(line => line.startsWith('Event dropped'));
  expect(dropped).toHaveLength(10);
  expect(lines().filter(line => line === 'More events were dropped this hour; they are not listed.')).toHaveLength(1);
});
