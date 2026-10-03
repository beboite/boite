import { afterEach, beforeEach, expect, test } from 'bun:test';
import { echoThread, startTestCore, type TestCore } from './harness';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });

test('opening subscribes, replaces the previous thread and restores pending cards in one snapshot', async () => {
  const client = await harness.connect();
  const previous = await echoThread(harness, client, 'Previous');
  const { threadId } = await echoThread(harness, client, 'Opened');
  await client.call('threads.subscribe', { threadId: previous.threadId });
  const opened = await client.call('threads.get', { threadId, sync: true, open: { previous: previous.threadId, markRead: true } });
  expect(opened.opened).toEqual({ permissions: [], questions: [] });
  expect(opened.unread).toBe(false);
  const event = client.next('message.started', message => message.threadId === threadId);
  harness.core.bus.emit('message.started', { id: 'subscribed', threadId, turnId: 'turn', role: 'assistant', parts: [], state: 'streaming', createdAt: 1 });
  expect((await event).id).toBe('subscribed');
});

test('a quiet return omits its unchanged payload and an unseen tool suffix still invalidates the proof', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  harness.core.journal.putTurn({ id: 'finished', threadId, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null });
  harness.core.journal.putMessage({ id: 'latest', threadId, turnId: 'finished', role: 'assistant', state: 'complete', createdAt: 1,
    parts: [{ type: 'tool', toolId: 'large', name: 'Bash', input: {}, output: 'same prefix '.repeat(4000) + 'before', status: 'done' }] });
  const first = await client.call('threads.get', { threadId, compactTools: true, sync: true });
  expect(first.messagesSync?.from).toBe('latest');
  const quiet = await client.call('threads.get', { threadId, after: 'latest', compactTools: true, sync: first.messagesSync });
  expect(quiet.messages).toEqual([]);
  expect(quiet.messagesUnchanged).toBe(true);
  expect(quiet.messagesFrom).toBe('latest');
  const changed = harness.core.journal.getMessage('latest')!;
  if (changed.parts[0]?.type !== 'tool') throw new Error('fixture needs a tool');
  changed.parts[0].output = 'same prefix '.repeat(4000) + 'after!';
  harness.core.journal.putMessage(changed);
  const fresh = await client.call('threads.get', { threadId, after: 'latest', compactTools: true, sync: first.messagesSync });
  expect(fresh.messagesUnchanged).toBeUndefined();
  expect(fresh.messages).toHaveLength(1);
  expect(fresh.messagesSync?.hash).not.toBe(first.messagesSync?.hash);
});

test('opening and quiet reconnect snapshots retain durable native background history after completion', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const finished = client.next('turn.finished', turn => turn.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: 'Snapshot history' });
  const turn = await finished;
  const source = harness.core.threads.require(threadId);
  const owner = { providerId: source.providerId, sessionGeneration: source.sessionGeneration ?? 0, parentTurnId: turn.id };
  harness.core.threads.agentState.noteBackground(threadId, [{ id: 'snapshot-native-task', kind: 'shell', description: 'Native work', toolId: null, startedAt: Date.now() }], owner);
  const opened = await client.call('threads.get', { threadId, compactFiles: true, sync: true, open: { markRead: true } });
  expect(opened.background).toHaveLength(1);
  expect(opened.backgroundHistory).toMatchObject([{ id: 'snapshot-native-task', state: 'running', parentTurnId: turn.id }]);
  expect(opened.opened).toEqual({ permissions: [], questions: [] });
  if (!opened.messagesSync) throw new Error('completed fixture needs a resume proof');
  harness.core.threads.agentState.finishBackground(threadId, 'snapshot-native-task', owner, 'completed');
  const reconnected = await harness.connect();
  const quiet = await reconnected.call('threads.get', {
    threadId, after: opened.messagesSync.from, compactFiles: true, sync: opened.messagesSync, open: { markRead: true },
  });
  expect(quiet.messages).toEqual([]);
  expect(quiet.messagesUnchanged).toBe(true);
  expect(quiet.background).toEqual([]);
  expect(quiet.backgroundHistory).toMatchObject([{ id: 'snapshot-native-task', state: 'completed', parentTurnId: turn.id }]);
  const { Core } = await import('../src/core');
  const restarted = new Core({ dataDir: harness.dataDir, token: harness.token });
  try {
    const restored = restarted.threads.get(threadId, undefined, { compactFiles: true, sync: true });
    expect(restored.background).toEqual([]);
    expect(restored.backgroundHistory).toEqual(quiet.backgroundHistory);
  } finally { await restarted.close(); }
});
