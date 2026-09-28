import { afterEach, beforeEach, expect, test } from 'bun:test';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const EVENT_TIMEOUT_MS = 5_000;

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

test('a running thread says since when its turn runs, and a finished one says nothing', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client, 'slow');
  await client.call('threads.subscribe', { threadId });
  const running = client.next(
    'thread.updated',
    (thread) => thread.id === threadId && thread.status === 'running',
    EVENT_TIMEOUT_MS,
  );
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, EVENT_TIMEOUT_MS);
  const before = Date.now();
  await client.call('turns.start', { threadId, prompt: '[sleep:400] slow' });

  // The time the turn started, the same on the event and on a fresh list.
  const busy = await running;
  expect(busy.runningSince).toBeGreaterThanOrEqual(before);
  expect(busy.runningSince).toBeLessThanOrEqual(Date.now());
  const listed = (await client.call('threads.list', {})).find((thread) => thread.id === threadId);
  expect(listed?.runningSince).toBe(busy.runningSince);

  expect((await finished).status).toBe('done');
  await waitFor(() => harness.core.threads.list({}).some((thread) => thread.id === threadId && thread.status === 'idle'));
  const idle = (await client.call('threads.list', {})).find((thread) => thread.id === threadId);
  expect(idle?.runningSince).toBeNull();
});
