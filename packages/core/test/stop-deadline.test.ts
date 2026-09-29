import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setDriver } from '../src/drivers/index.ts';
import type { Driver, TurnResult } from '../src/drivers/types.ts';
import { STOP_DEADLINE, STOP_DEADLINE_ERROR } from '../src/threads/turn-runner.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const saved = { ...STOP_DEADLINE };
let harness: TestCore;

beforeEach(async () => {
  STOP_DEADLINE.ms = 100;
  STOP_DEADLINE.forceMs = 100;
  harness = await startTestCore();
});

afterEach(async () => {
  Object.assign(STOP_DEADLINE, saved);
  await harness.stop();
});

test('a driver that never settles its stop is ended by the core', async () => {
  let wedged = true;
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      // The first turn ignores its stop for good; the next one answers at once.
      if (wedged) {
        wedged = false;
        return { stop() {}, done: new Promise<TurnResult>(() => {}) };
      }
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  } as unknown as Driver);
  const kills: string[] = [];
  const killTree = harness.core.procs.killTree.bind(harness.core.procs);
  harness.core.procs.killTree = (id: string) => { kills.push(id); return killTree(id); };
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const projectId = harness.core.journal.getThread(threadId)?.projectId ?? '';
    const { id: turnId } = await client.call('turns.start', { threadId, prompt: 'hi' });
    await waitFor(() => harness.core.threads.get(threadId).status === 'running');
    await client.call('turns.stop', { threadId });
    await waitFor(() => harness.core.journal.getTurn(turnId)?.status === 'stopped', 3000);
    expect(harness.core.journal.getTurn(turnId)?.error).toBe(STOP_DEADLINE_ERROR);
    expect(kills).toContain(threadId);
    await waitFor(() => harness.core.threads.get(threadId).status === 'idle', 3000);

    // The thread takes a new turn, and a project removal no longer waits on it.
    const second = await client.call('turns.start', { threadId, prompt: 'again' });
    await waitFor(() => harness.core.journal.getTurn(second.id)?.status === 'done', 3000);
    await client.call('projects.remove', { projectId });
  } finally {
    restore();
  }
}, 15_000);

test('a driver that settles its stop in time is never killed', async () => {
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      const settled = Promise.withResolvers<TurnResult>();
      return { stop() { settled.resolve({ status: 'stopped', sessionId: null, usage: null }); }, done: settled.promise };
    },
  } as unknown as Driver);
  const kills: string[] = [];
  const killTree = harness.core.procs.killTree.bind(harness.core.procs);
  harness.core.procs.killTree = (id: string) => { kills.push(id); return killTree(id); };
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const { id: turnId } = await client.call('turns.start', { threadId, prompt: 'hi' });
    await waitFor(() => harness.core.threads.get(threadId).status === 'running');
    await client.call('turns.stop', { threadId });
    await waitFor(() => harness.core.journal.getTurn(turnId)?.status === 'stopped', 3000);
    await Bun.sleep(STOP_DEADLINE.ms + STOP_DEADLINE.forceMs + 100);
    expect(kills).not.toContain(threadId);
    expect(harness.core.journal.getTurn(turnId)?.error).toBeNull();
  } finally {
    restore();
  }
}, 15_000);
