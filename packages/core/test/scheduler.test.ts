import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SchedulerState } from '@boite/contracts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import type { CoreClient } from '../src/client.ts';

let harness: TestCore;

async function threeThreads(client: CoreClient): Promise<string[]> {
  const project = await client.call('projects.add', { path: harness.dataDir, name: 'scheduler' });
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  const ids: string[] = [];
  for (const title of ['one', 'two', 'three']) {
    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'echo',
      accountId: account.id,
      title,
    });
    ids.push(thread.id);
  }
  return ids;
}

beforeEach(async () => {
  harness = await startTestCore({ settings: { maxConcurrentTurns: 2, perAccountConcurrency: 2 } });
});

afterEach(async () => {
  await harness.stop();
});

describe('scheduler', () => {
  test('refuses a second in-flight turn without journaling its prompt', async () => {
    const client = await harness.connect();
    const [threadId = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId, prompt: '[sleep:60000] first' });
    await expect(client.call('turns.start', { threadId, prompt: 'must not land' })).rejects.toThrow('in-flight');
    expect(harness.core.threads.get(threadId).turns).toHaveLength(1);
  });

  test('archiving a queued thread stops its turn and refuses new turns', async () => {
    const client = await harness.connect();
    await client.call('settings.set', { maxConcurrentTurns: 1 });
    const [running = '', queued = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId: running, prompt: '[sleep:60000]' });
    await client.call('turns.start', { threadId: queued, prompt: 'must not run' });
    harness.core.threads.archive(queued, true);
    expect(harness.core.scheduler.state().queued).toHaveLength(0);
    expect(harness.core.threads.get(queued).turns[0]?.status).toBe('stopped');
    expect(harness.core.threads.get(queued).status).toBe('idle');
    expect(() => harness.core.threads.startTurn(queued, 'no')).toThrow('archived');
  });

  test('clean shutdown marks queued turns stopped', async () => {
    const client = await harness.connect();
    await client.call('settings.set', { maxConcurrentTurns: 1 });
    const [running = '', queued = ''] = await threeThreads(client);
    await client.call('turns.start', { threadId: running, prompt: '[sleep:60000]' });
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

  test('concurrency caps require positive integers', () => {
    for (const key of ['maxConcurrentTurns', 'perAccountConcurrency'] as const) {
      for (const value of [0, 0.5, 1.5]) {
        expect(() => harness.core.settings.set({ [key]: value })).toThrow('positive integer');
      }
    }
  });

  test('a third turn waits its turn and runs when a slot frees', async () => {
    const client = await harness.connect();
    const threads = await threeThreads(client);

    const states: SchedulerState[] = [];
    client.on('scheduler.updated', (state) => states.push(state));

    for (const threadId of threads) {
      await client.call('turns.start', { threadId, prompt: '[sleep:300]' });
    }

    const queued = await client.call('scheduler.get', {});
    expect(queued.maxConcurrentTurns).toBe(2);
    expect(queued.running).toHaveLength(2);
    expect(queued.queued).toHaveLength(1);
    expect(queued.queued[0]?.threadId).toBe(threads[2] ?? '');
    expect(queued.queued[0]?.position).toBe(0);

    const third = await client.call('threads.get', { threadId: threads[2] ?? '' });
    expect(third.status).toBe('queued');

    await waitFor(() => states.some((state) => state.queued.length === 1), 3000);

    await client.next('turn.finished', (turn) => turn.threadId === threads[2], 15000);
    const settled = await client.call('scheduler.get', {});
    expect(settled.running).toHaveLength(0);
    expect(settled.queued).toHaveLength(0);
  });

  test('turns.stop removes a queued turn', async () => {
    const client = await harness.connect();
    const threads = await threeThreads(client);
    for (const threadId of threads) {
      await client.call('turns.start', { threadId, prompt: '[sleep:400]' });
    }

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

  test('perAccountConcurrency caps one account below the global cap', async () => {
    const client = await harness.connect();
    await client.call('settings.set', { maxConcurrentTurns: 6, perAccountConcurrency: 1 });
    const threads = await threeThreads(client);
    for (const threadId of threads) {
      await client.call('turns.start', { threadId, prompt: '[sleep:300]' });
    }
    const state = await client.call('scheduler.get', {});
    expect(state.running).toHaveLength(1);
    expect(state.queued).toHaveLength(2);
  });
});
