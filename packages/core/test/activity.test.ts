import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Core } from '../src/core.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

test('goal continues across turns, reports tasks and stops only on completion', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let count = 0;
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      count++;
      expect(ctx.prompt).toContain('[BOITE_GOAL_COMPLETE]');
      ctx.tasks?.([{ id: '1', text: 'Verify result', status: count === 1 ? 'in_progress' : 'completed' }]);
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: count === 1 ? 'More work remains.' : 'Verified.\n[BOITE_GOAL_COMPLETE]' });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: 'goal-session', usage: null }) };
    },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Verify the change' } });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');
  expect(count).toBe(2);
  const thread = await client.call('threads.get', { threadId });
  expect(thread.activity?.tasks[0]?.status).toBe('completed');
  expect(thread.activity?.goal?.iterations).toBe(2);
  const prompt = thread.messages.find(message => message.role === 'user')?.parts[0];
  expect(prompt).toEqual({ type: 'text', text: '/goal Verify the change', activity: { kind: 'goal', iteration: 1 } });
});

test('counted loops run consecutive iterations, retain each result and stop at the requested count', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let count = 0;
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    count++;
    expect(ctx.prompt).toContain(`Iteration ${count}.`);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: `pong ${count}` });
    ctx.emit.complete(id, 'complete');
    return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'say pong', intervalMs: 0, maxIterations: 2 } });
  await waitFor(() => h.core.activity.get(threadId).loop?.status === 'complete');
  const loop = h.core.activity.get(threadId).loop!;
  expect(count).toBe(2);
  expect(loop.nextRunAt).toBeNull();
  expect(loop.history?.map(run => [run.iteration, run.status, run.summary])).toEqual([[1, 'done', 'pong 1'], [2, 'done', 'pong 2']]);
  await expect(client.call('threads.activity.control', { threadId, kind: 'loop', action: 'resume' })).rejects.toThrow('finished');
  await Bun.sleep(400);
  expect(count).toBe(2);
});

test('finished tasks retire on a user prompt and new work brings them back', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.activity.tasks(threadId, [{ id: 'one', text: 'Done', status: 'completed' }]);
  await client.call('turns.start', { threadId, prompt: 'next request' });
  expect(h.core.activity.get(threadId).tasksDismissed).toBe(true);
  h.core.activity.tasks(threadId, [{ id: 'one', text: 'Done', status: 'completed' }]);
  expect(h.core.activity.get(threadId).tasksDismissed).toBe(true);
  h.core.activity.tasks(threadId, [{ id: 'two', text: 'New task', status: 'in_progress' }]);
  expect(h.core.activity.get(threadId).tasksDismissed).toBe(false);
});

test('loop repeats, Escape pauses it while idle, resume runs again, remove clears it', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let count = 0;
  restore = setDriver('echo', { protocol: 'echo', startTurn() { count++; return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) }; } });
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'check', intervalMs: 1000 } });
  await waitFor(() => count >= 2);
  await waitFor(() => h.core.threads.get(threadId).status === 'idle');
  await client.call('turns.stop', { threadId });
  expect(h.core.activity.get(threadId).loop?.status).toBe('paused');
  expect(h.core.activity.get(threadId).loop?.nextRunAt).toBeNull();
  const stoppedAt = count;
  await Bun.sleep(1100);
  expect(count).toBe(stoppedAt);
  await client.call('threads.activity.control', { threadId, kind: 'loop', action: 'resume' });
  await waitFor(() => count > stoppedAt);
  await client.call('threads.activity.control', { threadId, kind: 'loop', action: 'remove' });
  expect(h.core.activity.get(threadId).loop).toBeNull();
});

test('errors pause both modes and preserve the reported error', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  restore = setDriver('echo', { protocol: 'echo', startTurn() { return { stop() {}, done: Promise.resolve({ status: 'error', error: 'agent failed', sessionId: null, usage: null }) }; } });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'finish' }, loop: { prompt: 'check', intervalMs: 1000 } });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'paused');
  expect(h.core.activity.get(threadId).loop?.status).toBe('paused');
  expect(h.core.activity.get(threadId).goal?.error).toBe('agent failed');
});

test('restart preserves tasks and pauses persisted active work', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.journal.setSetting(`activity:${threadId}`, { goal: { objective: 'later', status: 'active', iterations: 3, error: null }, loop: null, tasks: [{ id: 'a', text: 'Saved task', status: 'pending' }] });
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(restarted.activity.get(threadId).goal?.status).toBe('paused');
    expect(restarted.activity.get(threadId).goal?.iterations).toBe(3);
    expect(restarted.activity.get(threadId).tasks[0]?.text).toBe('Saved task');
  } finally { await restarted.close(); }
});

test('invalid intervals and empty objectives are refused without mutations', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  for (const intervalMs of [0, 999, 1000.5, 86400001]) {
    await expect(client.call('threads.activity.set', { threadId, loop: { prompt: 'check', intervalMs } })).rejects.toThrow('intervalMs');
  }
  await expect(client.call('threads.activity.set', { threadId, goal: { objective: ' ' } })).rejects.toThrow('objective');
  expect(h.core.activity.get(threadId)).toEqual({ goal: null, loop: null, tasks: [] });
});

test('a paired phone manages activity and receives task and pause events over RPC', async () => {
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    const seen: import('@boite/contracts').ThreadActivity[] = [];
    phone.on('thread.activity', (event) => { if (event.threadId === threadId) seen.push(event.activity); });
    await phone.call('threads.subscribe', { threadId });
    await phone.call('threads.activity.set', { threadId, loop: { prompt: 'check', intervalMs: 60000 } });
    await phone.call('turns.stop', { threadId });
    await waitFor(() => seen.some((state) => state.loop?.status === 'paused'));
    h.core.activity.tasks(threadId, [{ id: 'a', text: 'Phone task', status: 'in_progress' }]);
    await waitFor(() => seen.some((state) => state.tasks[0]?.text === 'Phone task'));
    expect((await phone.call('threads.get', { threadId })).activity?.tasks[0]?.text).toBe('Phone task');
    await phone.call('threads.activity.control', { threadId, kind: 'loop', action: 'remove' });
    expect((await phone.call('threads.get', { threadId })).activity?.loop).toBeNull();
  } finally { phone.close(); }
});

test('TodoWrite and incremental Task tools update activity without discarding the goal', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const emit = (name: string, input: unknown, output: string | null = null) => h.core.bus.emit('message.part', { threadId, messageId: 'm', partIndex: 0, part: { type: 'tool', toolId: 'tool-call-99', name, input, output, status: 'done' } });
  emit('TodoWrite', { todos: [{ content: 'Read source', status: 'completed' }, { content: 'Run checks', status: 'in_progress' }] });
  expect(h.core.activity.get(threadId).tasks).toHaveLength(2);
  emit('TaskCreate', { subject: 'Review result' }, JSON.stringify({ task: { id: 'task-1' } }));
  emit('TaskUpdate', { taskId: 'task-1', status: 'completed' });
  expect(h.core.activity.get(threadId).tasks.find((task) => task.id === 'task-1')?.status).toBe('completed');
});

test('replacing an in-flight goal cannot complete the replacement with the old answer', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let finish!: () => void;
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      return { stop() {}, done: new Promise((resolve) => {
        finish = () => {
          const id = ctx.emit.startMessage('assistant');
          ctx.emit.part(id, 0, { type: 'text', text: '[BOITE_GOAL_COMPLETE]' });
          ctx.emit.complete(id, 'complete');
          resolve({ status: 'done', sessionId: null, usage: null });
        };
      }) };
    },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'first' } });
  await waitFor(() => !!finish);
  await client.call('threads.activity.set', { threadId, goal: { objective: 'second' } });
  finish();
  await waitFor(() => h.core.threads.get(threadId).status === 'idle');
  expect(h.core.activity.get(threadId).goal?.status).toBe('active');
  expect(h.core.activity.get(threadId).goal?.objective).toBe('second');
  await client.call('turns.stop', { threadId });
});

test.each(['error', 'stopped'] as const)('an obsolete %s turn cannot pause or strand its replacement', async status => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let finish!: () => void;
  let count = 0;
  restore = setDriver('echo', { protocol: 'echo', startTurn() {
    count++;
    return { stop() {}, done: count === 1 ? new Promise(resolve => {
      finish = () => resolve({ status, sessionId: null, usage: null });
    }) : Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'old', intervalMs: 0, maxIterations: 1 } });
  await waitFor(() => !!finish);
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'replacement', intervalMs: 0, maxIterations: 1 } });
  finish();
  await waitFor(() => h.core.activity.get(threadId).loop?.status === 'complete');
  expect(count).toBe(2);
  expect(h.core.activity.get(threadId).loop?.history).toHaveLength(1);
});
