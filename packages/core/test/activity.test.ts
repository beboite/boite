import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Core } from '../src/core.ts';
import { ActivityStore } from '../src/activity.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

test.each([
  ['quoted complete', 'Not finished.\n```\n[BOITE_GOAL_COMPLETE]\n```', 0, 'active'],
  ['quoted blocked', 'Continuing.\n~~~text\n[BOITE_GOAL_BLOCKED]\n~~~', 0, 'active'],
  ['indented example', 'Example:\n    [BOITE_GOAL_COMPLETE]', 0, 'active'],
  ['beyond page', '[BOITE_GOAL_COMPLETE]', 120, 'complete'],
] as const)('goal marker: %s', async (_name, text, extraMessages, expected) => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  restore = setDriver('echo', {
    protocol: 'echo', startTurn(ctx) {
      for (let i = 0; i <= extraMessages; i++) {
        const id = ctx.emit.startMessage('assistant');
        ctx.emit.part(id, 0, { type: 'text', text: i === 0 ? text : 'Additional output.' });
        ctx.emit.complete(id, 'complete');
      }
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  });
  h.core.activity.set({ threadId, goal: { objective: 'Check completion' } });
  await waitFor(() => h.core.activity.get(threadId).goal!.iterations > 0 && h.core.threads.get(threadId).status === 'idle');
  expect(h.core.activity.get(threadId).goal?.status).toBe(expected);
  h.core.activity.pauseAll(threadId);
});

test('paused activity produces no new events when loaded or closed again', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.activity.set({ threadId, goal: { objective: 'Wait' } });
  h.core.activity.pauseAll(threadId);
  const count = () => (h.core.journal.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'thread.activity'").get() as { n: number }).n;
  const before = count();
  h.core.activity.close();
  expect(count()).toBe(before);
  const loaded = new ActivityStore(h.core);
  loaded.close();
  expect(count()).toBe(before);
});

test('starting a turn does not decode historical messages to read its prompt', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.journal.putMessage({ id: 'history', threadId, turnId: 'old', role: 'assistant', state: 'complete', createdAt: 0, parts: [{ type: 'text', text: 'old'.repeat(1000) }] });
  const original = h.core.journal.listMessages.bind(h.core.journal);
  h.core.journal.listMessages = () => { throw new Error('unbounded history read'); };
  let prompt: string | undefined;
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    prompt = ctx.prompt;
    return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  try {
    const turn = h.core.threads.startTurn(threadId, 'current prompt');
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt !== null);
    expect(prompt).toBe('current prompt');
  } finally { h.core.journal.listMessages = original; }
});

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
