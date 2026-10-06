import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AgentProfile } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let client: Awaited<ReturnType<TestCore['connect']>>;
let agent: AgentProfile;
let restore: (() => void) | undefined;
const prompts: string[] = [];

/** Each turn answers with the next scripted text. */
function script(...answers: string[]): void {
  prompts.length = 0;
  restore = setDriver('echo', {
    protocol: 'echo', startTurn(ctx) {
      prompts.push(ctx.prompt);
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: answers[prompts.length - 1] ?? 'Idle.' });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: 'entrusted-session', usage: null }) };
    },
  });
}
const threadMessages = () => h.core.workforce.records.list('message').filter(m => m.thread);

beforeEach(async () => {
  // The persona joins turns with the rest of Boite's own guide text.
  h = await startTestCore({ boiteGuide: true }); client = await h.connect();
  h.core.workforce.setLimits({ paused: true, backgroundConcurrency: 2, kebaccExperiment: false });
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  agent = await client.call('agents.profile.save', { value: { name: 'Ada', domain: 'Builds', instructions: 'Always run the tests before answering.', avatar: '', status: 'active', tools: ['messages'], accountIntegration: 'provider', selection: { providerId: 'echo', accountId: account.id, model: 'echo', effort: null, permissionMode: 'default' } } });
});
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

test('refuses threads and agents that cannot be entrusted', async () => {
  const { threadId } = await echoThread(h, client);
  const paused = await client.call('agents.profile.save', { value: { ...agent, name: 'Resting', status: 'paused' } });
  const thread = h.core.journal.getThread(threadId)!;
  h.core.journal.putThread({ ...thread, id: 'child', parentThreadId: threadId });
  h.core.journal.putThread({ ...thread, id: 'session', agentSessionId: 'agt_session_x' });
  h.core.journal.putThread({ ...thread, id: 'archived', archived: true });
  h.core.journal.putThread({ ...thread, id: 'loose', projectId: null });
  for (const [params, error] of [
    [{ threadId: 'child', agentId: agent.id }, 'delegated child'],
    [{ threadId: 'session', agentId: agent.id }, 'persistent agent session'],
    [{ threadId: 'archived', agentId: agent.id }, 'unarchived'],
    [{ threadId: 'missing', agentId: agent.id }, 'existing'],
    [{ threadId: 'loose', agentId: agent.id }, 'project'],
    [{ threadId, agentId: 'agt_profile_unknown' }, 'agentId: expected an active agent'],
    [{ threadId, agentId: paused.id }, 'agentId: expected an active agent'],
    [{ threadId, agentId: agent.id, objective: 'x'.repeat(4001) }, 'objective'],
    [{ threadId, agentId: agent.id, objective: 7 as unknown as string }, 'objective'],
  ] as const) await expect(client.call('agents.entrust', params)).rejects.toThrow(error);
  expect(h.core.workforce.entrusted.list()).toEqual([]);
  expect(threadMessages()).toEqual([]);
});

test('entrusting starts the goal, carries the persona and posts one done message', async () => {
  const { threadId } = await echoThread(h, client, 'Fix the login');
  h.core.workforce.setLimits({ paused: false, backgroundConcurrency: 2, kebaccExperiment: false });
  script('All tests pass. The login works.\n[BOITE_GOAL_COMPLETE]');
  const entry = await client.call('agents.entrust', { threadId, agentId: agent.id });
  expect(entry).toMatchObject({ threadId, agentId: agent.id, objective: 'Take over this work where it stands and carry it to a verified result.' });
  const [taken] = threadMessages();
  expect(taken).toMatchObject({ scope: { kind: 'agent', id: agent.id }, senderId: agent.id, text: 'I am taking over "Fix the login".', recipientIds: [], thread: { id: threadId, title: 'Fix the login', event: 'entrusted' } });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');
  expect(prompts[0]).toContain('their agent Ada (Builds)');
  expect(prompts[0]).toContain('Always run the tests before answering.');
  expect(threadMessages().map(m => [m.thread!.event, m.text])).toEqual([['entrusted', 'I am taking over "Fix the login".'], ['done', 'All tests pass. The login works.']]);
  expect(h.core.workforce.entrusted.list()).toEqual([]);
  // Nothing was delivered to the agent: its messages enqueue no work.
  expect(h.core.workforce.records.list('work')).toEqual([]);
  expect(h.core.workforce.entrusted.instructions(threadId)).toBe('');
});

test('a blocker keeps the entrustment and taking it back removes the goal', async () => {
  const { threadId } = await echoThread(h, client);
  script('Which database?\n[BOITE_GOAL_BLOCKED]');
  await client.call('agents.entrust', { threadId, agentId: agent.id, objective: '  Migrate  ' });
  await waitFor(() => h.core.activity.get(threadId).goal?.blocked === true && h.core.threads.get(threadId).status === 'idle');
  expect(threadMessages().map(m => [m.thread!.event, m.text])).toEqual([['entrusted', 'I am taking over "echo thread".'], ['blocked', 'Which database?']]);
  expect((await client.call('agents.snapshot', {})).entrusted).toMatchObject([{ threadId, agentId: agent.id, objective: 'Migrate' }]);
  expect(await client.call('agents.entrust', { threadId, agentId: null })).toBeNull();
  expect(h.core.activity.get(threadId).goal).toBeNull();
  expect(h.core.workforce.entrusted.list()).toEqual([]);
  expect(threadMessages()).toHaveLength(2);
});

test('archiving drops the entrustment', async () => {
  const { threadId } = await echoThread(h, client);
  script('Working.');
  await client.call('agents.entrust', { threadId, agentId: agent.id, objective: 'Keep going' });
  await waitFor(() => h.core.activity.get(threadId).goal!.iterations > 0);
  await client.call('threads.archive', { threadId });
  await waitFor(() => h.core.workforce.entrusted.list().length === 0);
  expect(threadMessages().map(m => m.thread!.event)).toEqual(['entrusted']);
});

test('a failed goal turn posts one stopped message and keeps the entrustment', async () => {
  const { threadId } = await echoThread(h, client);
  restore = setDriver('echo', { protocol: 'echo', startTurn() {
    return { stop() {}, done: Promise.resolve({ status: 'error', sessionId: null, usage: null, error: 'Provider quota reached.' }) };
  } });
  await client.call('agents.entrust', { threadId, agentId: agent.id });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'paused' && h.core.threads.get(threadId).status !== 'running');
  expect(threadMessages().map(m => [m.thread!.event, m.text])).toEqual([['entrusted', 'I am taking over "echo thread".'], ['stopped', 'Provider quota reached.']]);
  expect(h.core.workforce.entrusted.list()).toHaveLength(1);
});
