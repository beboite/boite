import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RpcErrorCode, type SchedulerState } from '@boite/contracts';
import { holdAccountTurns, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import type { CoreClient } from '../src/client.ts';

let harness: TestCore;

async function threeThreads(client: CoreClient, count = 3): Promise<string[]> {
  const project = await client.call('projects.add', { path: harness.dataDir, name: 'scheduler' });
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'echo',
      accountId: account.id,
      title: `thread ${index + 1}`,
    });
    ids.push(thread.id);
  }
  return ids;
}

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('scheduler', () => {
  test('thirty user turns on one account start despite stored legacy concurrency limits', async () => {
    const client = await harness.connect();
    const threads = await threeThreads(client, 30);
    harness.core.journal.setSetting('settings', { maxConcurrentTurns: 1, perAccountConcurrency: 1 });
    for (const threadId of threads) await client.call('turns.start', { threadId, prompt: '[sleep:60000]' });
    const state = await client.call('scheduler.get', {});
    expect(state.running).toHaveLength(30);
    expect(state.queued).toEqual([]);
    expect(state.running.map(entry => entry.threadId)).toEqual(threads);
  });

  test('shutdown refuses new turns before they reach the journal', async () => {
    const client = await harness.connect();
    const [threadId = ''] = await threeThreads(client);
    await harness.core.drain();
    await expect(client.call('turns.start', { threadId, prompt: 'late prompt' })).rejects.toThrow('stopping');
    expect(harness.core.journal.listTurns(threadId)).toEqual([]);
    expect(harness.core.journal.listMessages(threadId)).toEqual([]);
  });

  test('shutdown pauses delayed activity before waiting for running turns', async () => {
    const client = await harness.connect();
    const [threadId = ''] = await threeThreads(client);
    harness.core.activity.set({ threadId, goal: { objective: 'must not start during shutdown' } });
    await harness.core.drain();
    expect(harness.core.activity.get(threadId).goal?.status).toBe('paused');
    expect(harness.core.journal.listTurns(threadId)).toEqual([]);
  });

  test('refuses a second in-flight turn without journaling its prompt', async () => {
    const client = await harness.connect();
    const [threadId = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId, prompt: '[sleep:60000] first' });
    await expect(client.call('turns.start', { threadId, prompt: 'must not land' })).rejects.toThrow('in-flight');
    // The refusal says the prompt is early, not wrong, and carries the row a
    // client that had not seen this turn yet needs to wait for it.
    await expect(client.call('turns.start', { threadId, prompt: 'must not land' })).rejects.toMatchObject({
      rpc: { code: RpcErrorCode.Refused, data: { threadId, reason: 'turn-in-flight', thread: { id: threadId, status: 'running' } } },
    });
    expect(harness.core.threads.get(threadId).turns).toHaveLength(1);
  });

  test('archiving a queued thread stops its turn and refuses new turns', async () => {
    const client = await harness.connect();
    const [running = '', queued = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId: running, prompt: '[sleep:60000]' });
    holdAccountTurns(harness);
    await client.call('turns.start', { threadId: queued, prompt: 'must not run' });
    harness.core.threads.archive(queued, true);
    expect(harness.core.scheduler.state().queued).toHaveLength(0);
    expect(harness.core.threads.get(queued).turns[0]?.status).toBe('stopped');
    expect(harness.core.threads.get(queued).status).toBe('idle');
    expect(() => harness.core.threads.startTurn(queued, 'no')).toThrow('archived');
  });

  test('clean shutdown marks queued turns stopped', async () => {
    const client = await harness.connect();
    const [running = '', queued = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId: running, prompt: '[sleep:60000]' });
    holdAccountTurns(harness);
    await client.call('turns.start', { threadId: queued, prompt: 'wait' });
    await harness.core.scheduler.drain();
    expect(harness.core.threads.get(queued).turns[0]?.status).toBe('stopped');
  });

  test('drain gives up on a turn that ignores its stop instead of hanging shutdown', async () => {
    const client = await harness.connect();
    const [running = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId: running, prompt: '[sleep:60000]' });
    await waitFor(() => harness.core.scheduler.state().running.length === 1);
    // A driver that never answers its stop. The wait used to have no deadline,
    // so one of these held the whole shutdown open for ever.
    const stopRunning = harness.core.threads.stopRunning.bind(harness.core.threads);
    harness.core.threads.stopRunning = () => true;
    try {
      const started = Date.now();
      await harness.core.scheduler.drain(150);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      harness.core.threads.stopRunning = stopRunning;
    }
    // Still running: the deadline gave up waiting on it, it did not kill it.
    expect(harness.core.scheduler.state().running.length).toBe(1);
  });

  test('a shutdown waits once for a turn that ignores its stop, not once per phase', async () => {
    const client = await harness.connect();
    const [running = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId: running, prompt: '[sleep:60000]' });
    await waitFor(() => harness.core.scheduler.state().running.length === 1);
    harness.core.threads.stopRunning = () => true;
    await harness.core.drain(150);
    // Spending the budget again in close() used to run shutdown past its own
    // ten seconds and skip every step after the drain.
    const started = Date.now();
    await harness.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('close keeps the journal open until an overlapping drain finishes', async () => {
    const client = await harness.connect();
    const [running = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId: running, prompt: '[sleep:60000]' });
    await waitFor(() => harness.core.scheduler.state().running.length === 1);
    harness.core.threads.stopRunning = () => true;
    let journalOpenAfterDrain = false;
    const draining = harness.core.drain(1_000).then(() => {
      journalOpenAfterDrain = !harness.core.journal.isClosed();
    });
    await Promise.all([draining, harness.stop()]);
    expect(journalOpenAfterDrain).toBe(true);
    expect(harness.core.journal.isClosed()).toBe(true);
  });

  test('legacy concurrency settings are omitted from RPC responses', async () => {
    const client = await harness.connect();
    harness.core.journal.setSetting('settings', { maxConcurrentTurns: 1, perAccountConcurrency: 1 });
    const settings = await client.call('settings.get', {});
    const scheduler = await client.call('scheduler.get', {});
    for (const key of ['maxConcurrentTurns', 'perAccountConcurrency']) {
      expect(settings).not.toHaveProperty(key);
      expect(scheduler).not.toHaveProperty(key);
    }
  });

  test('a synchronous burst publishes one current scheduler snapshot to the client', async () => {
    const client = await harness.connect();
    const project = harness.core.projects.add(harness.dataDir, 'scheduler burst');
    const account = harness.core.accounts.list().find(entry => entry.providerId === 'echo')!;
    const threads = Array.from({ length: 64 }, (_, i) => harness.core.threads.create({
      projectId: project.id, providerId: 'echo', accountId: account.id, title: `burst ${i}`,
    }));
    const states: SchedulerState[] = [];
    client.on('scheduler.updated', state => states.push(state));
    holdAccountTurns(harness);
    for (const thread of threads) harness.core.threads.startTurn(thread.id, '[sleep:60000]');
    await waitFor(() => states.some(state => state.queued.length === threads.length));
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual(harness.core.scheduler.state());
  });

  test('a turn queued during an account login runs when the hold ends', async () => {
    const client = await harness.connect();
    const threads = await threeThreads(client);

    const states: SchedulerState[] = [];
    client.on('scheduler.updated', (state) => states.push(state));

    const finished = client.next('turn.finished', turn => turn.threadId === threads[2], 15000);
    for (const threadId of threads.slice(0, 2)) await client.call('turns.start', { threadId, prompt: '[sleep:60000]' });
    const release = holdAccountTurns(harness);
    await client.call('turns.start', { threadId: threads[2] ?? '', prompt: 'third' });

    const queued = await client.call('scheduler.get', {});
    expect(queued.running).toHaveLength(2);
    expect(queued.queued).toHaveLength(1);
    expect(queued.queued[0]?.threadId).toBe(threads[2] ?? '');
    expect(queued.queued[0]?.position).toBe(0);

    const third = await client.call('threads.get', { threadId: threads[2] ?? '' });
    expect(third.status).toBe('queued');

    await waitFor(() => states.some((state) => state.queued.length === 1), 3000);

    release();
    expect((await finished).status).toBe('done');
    await client.call('turns.stop', { threadId: threads[0]! });
    await client.call('turns.stop', { threadId: threads[1]! });
    await waitFor(() => harness.core.scheduler.state().running.length === 0);
    const settled = await client.call('scheduler.get', {});
    expect(settled.running).toHaveLength(0);
    expect(settled.queued).toHaveLength(0);
  });

  test('turns.stop removes a queued turn', async () => {
    const client = await harness.connect();
    const threads = await threeThreads(client);
    for (const threadId of threads.slice(0, 2)) await client.call('turns.start', { threadId, prompt: '[sleep:60000]' });
    holdAccountTurns(harness);
    await client.call('turns.start', { threadId: threads[2] ?? '', prompt: '[sleep:60000]' });

    const target = threads[2] ?? '';
    expect((await client.call('scheduler.get', {})).queued.map((entry) => entry.threadId)).toEqual([target]);

    const stopped = await client.call('turns.stop', { threadId: target });
    expect(stopped.stopped).toBe(true);
    expect((await client.call('scheduler.get', {})).queued).toHaveLength(0);

    const thread = await client.call('threads.get', { threadId: target });
    expect(thread.turns[0]?.status).toBe('stopped');
    expect(thread.status).toBe('idle');
  });

  test('turns.stop aborts a running turn mid-stream', async () => {
    const client = await harness.connect();
    const threads = await threeThreads(client);
    const target = threads[0] ?? '';
    await client.call('threads.subscribe', { threadId: target });

    const started = client.next('turn.started', (turn) => turn.threadId === target, 5000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === target, 10000);
    await client.call('turns.start', { threadId: target, prompt: '[sleep:2000]never streamed' });
    await started;

    expect((await client.call('turns.stop', { threadId: target })).stopped).toBe(true);
    const done = await finished;
    expect(done.status).toBe('stopped');
  });

  test('releasing an account login hold starts all its queued turns together', async () => {
    const client = await harness.connect();
    const threads = await threeThreads(client);
    const release = holdAccountTurns(harness);
    for (const threadId of threads) {
      await client.call('turns.start', { threadId, prompt: '[sleep:60000]' });
    }
    const state = await client.call('scheduler.get', {});
    expect(state.running).toHaveLength(0);
    expect(state.queued).toHaveLength(3);
    release();
    expect(harness.core.scheduler.state().running).toHaveLength(3);
    expect(harness.core.scheduler.state().queued).toHaveLength(0);
  });
});
