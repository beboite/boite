import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AgentProfile } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import { makeAgent } from './agent-fixture.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let h: TestCore;
let client: Awaited<ReturnType<TestCore['connect']>>;
let agent: AgentProfile;
let agentThread: string;
let restore: (() => void) | undefined;
const prompts: string[] = [];

/** Each turn of an ordinary thread answers with the next scripted text; the agent's own turns answer quietly. */
function script(...answers: string[]): void {
  prompts.length = 0;
  restore = setDriver('echo', {
    protocol: 'echo', startTurn(ctx) {
      const own = ctx.thread.id === agentThread;
      if (!own) prompts.push(ctx.prompt);
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: own ? '[quiet] read' : answers[prompts.length - 1] ?? 'Idle.' });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: 'entrusted-session', usage: null }) };
    },
  });
}
/** The lines Boite wrote in the agent's thread. */
const lines = () => h.core.journal.listMessages(agentThread).filter(m => m.role === 'system').flatMap(m => m.parts.flatMap(p => p.type === 'text' && p.displayText === undefined ? [p.text] : []));
const facts = () => h.core.agentRuntime.facts(agent.id);

beforeEach(async () => {
  // The persona joins turns with the rest of Boite's own guide text.
  h = await startTestCore({ boiteGuide: true }); client = await h.connect();
  ({ agent, threadId: agentThread } = await makeAgent(h, client, { domain: 'Builds', instructions: 'Always run the tests before answering.' }));
  // Facts stay waiting where the test reads them.
  h.core.workforce.setLimits({ paused: true });
});
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

test('refuses threads and agents that cannot be entrusted', async () => {
  const { threadId } = await echoThread(h, client);
  const resting = await makeAgent(h, client, { name: 'Resting', status: 'paused' });
  const thread = h.core.journal.getThread(threadId)!;
  h.core.journal.putThread({ ...thread, id: 'child', parentThreadId: threadId });
  h.core.journal.putThread({ ...thread, id: 'session', agentSessionId: 'agt_session_x' });
  h.core.journal.putThread({ ...thread, id: 'archived', archived: true });
  h.core.journal.putThread({ ...thread, id: 'loose', projectId: null });
  for (const [params, error] of [
    [{ threadId: 'child', agentId: agent.id }, 'delegated child'],
    [{ threadId: 'session', agentId: agent.id }, "not a bot's thread"],
    [{ threadId: 'archived', agentId: agent.id }, 'unarchived'],
    [{ threadId: 'missing', agentId: agent.id }, 'existing'],
    [{ threadId: 'loose', agentId: agent.id }, 'project'],
    [{ threadId, agentId: 'agt_profile_unknown' }, 'agentId: expected an active agent'],
    [{ threadId, agentId: resting.agent.id }, 'agentId: expected an active agent'],
    [{ threadId, agentId: agent.id, objective: 'x'.repeat(4001) }, 'objective'],
    [{ threadId, agentId: agent.id, objective: 7 as unknown as string }, 'objective'],
  ] as const) expect(await thrown(client.call('agents.entrust', params))).toThrow(error);
  expect(h.core.workforce.entrusted.list()).toEqual([]);
  expect(lines()).toEqual([]);
});

test('entrusting starts the goal, carries the persona, and its end wakes the agent and takes the thread off the desk', async () => {
  const { threadId } = await echoThread(h, client, 'Fix the login');
  script('All tests pass. The login works.\n[BOITE_GOAL_COMPLETE]');
  const entry = await client.call('agents.entrust', { threadId, agentId: agent.id });
  expect(entry).toMatchObject({ threadId, agentId: agent.id, objective: 'Take over this work where it stands and carry it to a verified result.' });
  expect(lines()).toEqual([`The user entrusted "Fix the login" (${threadId}) to you: Take over this work where it stands and carry it to a verified result.`]);
  // On the desk while it is entrusted (the take-back test reads it there); the goal here is met at once and takes it off.
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');
  expect(prompts[0]).toContain('their agent Ada (Builds)');
  expect(prompts[0]).toContain('Always run the tests before answering.');
  await waitFor(() => facts().some(f => f.text.startsWith(`Entrusted thread ${threadId}, titled "Fix the login": goal done.`)));
  expect(facts().find(f => f.key.startsWith('goal:'))!.text).toContain('All tests pass. The login works.');
  expect(h.core.workforce.entrusted.list()).toEqual([]);
  expect((await client.call('agents.snapshot', {})).watches.find(w => w.threadId === threadId)).toBeUndefined();
  expect(h.core.workforce.entrusted.instructions(threadId)).toBe('');
});

test('a blocker keeps the entrustment and wakes the agent; taking it back removes the goal', async () => {
  const { threadId } = await echoThread(h, client);
  script('Which database?\n[BOITE_GOAL_BLOCKED]');
  await client.call('agents.entrust', { threadId, agentId: agent.id, objective: '  Migrate  ' });
  await waitFor(() => h.core.activity.get(threadId).goal?.blocked === true && h.core.threads.get(threadId).status === 'idle');
  await waitFor(() => facts().some(f => f.text.includes('goal blocked')));
  expect(facts().find(f => f.text.includes('goal blocked'))!.text).toContain('Which database?');
  expect((await client.call('agents.snapshot', {})).entrusted).toMatchObject([{ threadId, agentId: agent.id, objective: 'Migrate' }]);
  expect(await client.call('agents.entrust', { threadId, agentId: null })).toBeNull();
  expect(h.core.activity.get(threadId).goal).toBeNull();
  expect(h.core.workforce.entrusted.list()).toEqual([]);
});

test('taking a thread back takes the grant: the watch goes unless the bot reaches the thread another way', async () => {
  script('Working.');
  const desk = async (threadId: string) => (await client.call('agents.snapshot', {})).watches.find(w => w.agentId === agent.id && w.threadId === threadId)?.origin ?? null;
  const entrustAndTakeBack = async (threadId: string) => {
    await client.call('agents.entrust', { threadId, agentId: agent.id, objective: 'Keep going' });
    expect(await desk(threadId)).not.toBeNull();
    await client.call('agents.entrust', { threadId, agentId: null });
  };
  // Nothing else ties the bot to it: the watch and the access leave together.
  const { threadId: plain } = await echoThread(h, client);
  await entrustAndTakeBack(plain);
  expect(await desk(plain)).toBeNull();
  expect(h.core.workforce.projects.follows(agent.id, plain)).toBe(false);
  // Entrusted to another bot: the first one's grant goes the same way.
  const { agent: other } = await makeAgent(h, client, { name: 'Other' });
  await client.call('agents.entrust', { threadId: plain, agentId: agent.id });
  await client.call('agents.entrust', { threadId: plain, agentId: other.id });
  expect(await desk(plain)).toBeNull();
  expect(h.core.workforce.projects.follows(other.id, plain)).toBe(true);
  await client.call('agents.entrust', { threadId: plain, agentId: null });
  // A thread it started stays its own.
  const { threadId: started } = await echoThread(h, client);
  h.core.workforce.projects.follow(agent.id, started, 'started');
  await entrustAndTakeBack(started);
  expect(await desk(started)).toBe('started');
  // A thread of a project entrusted to it stays, as a thread it follows there.
  const { threadId: inProject } = await echoThread(h, client);
  const current = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, projectIds: [h.core.threads.require(inProject).projectId!] } });
  await entrustAndTakeBack(inProject);
  expect(await desk(inProject)).toBe('followed');
  expect(h.core.workforce.projects.follows(agent.id, inProject)).toBe(true);
});

test('an entrustment that ends any way gives the grant back, and a watch the bot had before survives it', async () => {
  const desk = async (threadId: string) => (await client.call('agents.snapshot', {})).watches.find(w => w.agentId === agent.id && w.threadId === threadId)?.origin ?? null;
  // A met goal ends it: the thread leaves the desk, and the news of the goal still reaches the bot.
  script('Done.\n[BOITE_GOAL_COMPLETE]');
  const { threadId: met } = await echoThread(h, client, 'Ship it');
  await client.call('agents.entrust', { threadId: met, agentId: agent.id });
  await waitFor(() => h.core.workforce.entrusted.list().length === 0 && facts().some(f => f.text.includes('goal done')));
  expect(await desk(met)).toBeNull();
  expect(h.core.workforce.projects.follows(agent.id, met)).toBe(false);
  // Delivery reads again what the bot may hear: the goal's news passes that check.
  const news = facts().find(f => f.text.includes('goal done'))!;
  expect(h.core.agentRuntime.factThreads(news).every(id => h.core.workforce.projects.mayHear(agent, id))).toBe(true);
  // An archived thread ends it the same way.
  script('Working.');
  const { threadId: archived } = await echoThread(h, client);
  await client.call('agents.entrust', { threadId: archived, agentId: agent.id, objective: 'Keep going' });
  await client.call('threads.archive', { threadId: archived });
  await waitFor(() => h.core.workforce.entrusted.list().length === 0);
  expect(h.core.workforce.projects.follows(agent.id, archived)).toBe(false);
  // The owner put the thread on the bot's desk first: taking it back leaves that watch.
  const { threadId: watched } = await echoThread(h, client);
  await client.call('agents.watch', { agentId: agent.id, watchThreadId: watched, watched: true });
  await client.call('agents.entrust', { threadId: watched, agentId: agent.id, objective: 'Keep going' });
  await client.call('agents.entrust', { threadId: watched, agentId: null });
  expect(await desk(watched)).toBe('followed');
  expect(h.core.workforce.projects.follows(agent.id, watched)).toBe(true);
});

test('an owner watch added while a thread is entrusted is a grant of its own: it outlives the entrustment', async () => {
  script('Working.');
  const desk = async (threadId: string) => (await client.call('agents.snapshot', {})).watches.find(w => w.agentId === agent.id && w.threadId === threadId)?.origin ?? null;
  const { threadId } = await echoThread(h, client);
  await client.call('agents.entrust', { threadId, agentId: agent.id, objective: 'Keep going' });
  await client.call('agents.watch', { agentId: agent.id, watchThreadId: threadId, watched: true });
  await client.call('agents.entrust', { threadId, agentId: null });
  expect(await desk(threadId)).toBe('followed');
  expect(h.core.workforce.projects.follows(agent.id, threadId)).toBe(true);
  // A removed thread leaves the desk whatever brought it there.
  await client.call('threads.remove', { threadId });
  expect(await desk(threadId)).toBeNull();
});

test('archiving drops the entrustment', async () => {
  const { threadId } = await echoThread(h, client);
  script('Working.');
  await client.call('agents.entrust', { threadId, agentId: agent.id, objective: 'Keep going' });
  await waitFor(() => h.core.activity.get(threadId).goal!.iterations > 0);
  await client.call('threads.archive', { threadId });
  await waitFor(() => h.core.workforce.entrusted.list().length === 0);
  expect(facts().filter(f => f.key.startsWith('goal:'))).toEqual([]);
});

test('a failed goal turn leaves one line in the agent thread and keeps the entrustment', async () => {
  const { threadId } = await echoThread(h, client);
  restore = setDriver('echo', { protocol: 'echo', startTurn() {
    return { stop() {}, done: Promise.resolve({ status: 'error', sessionId: null, usage: null, error: 'Provider quota reached.' }) };
  } });
  await client.call('agents.entrust', { threadId, agentId: agent.id });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'paused' && h.core.threads.get(threadId).status !== 'running');
  await waitFor(() => lines().length === 2);
  expect(lines()[1]).toBe(`Entrusted thread ${threadId}, titled "echo thread": goal stopped.`);
  expect(h.core.workforce.entrusted.list()).toHaveLength(1);
});
