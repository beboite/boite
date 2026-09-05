import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const LONG_CHILD = process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('procs', () => {
  test('killTree kills the child a turn spawned', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const started = client.next('process.started', (record) => record.threadId === threadId, 10000);
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 15000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);

    await client.call('turns.start', { threadId, prompt: `[spawn:${LONG_CHILD}]` });
    const child = await started;
    expect(child.pid).toBeGreaterThan(0);
    expect(child.commandLine).toContain(LONG_CHILD);
    expect(child.exitedAt).toBeNull();

    await waitFor(() => harness.core.procs.liveCount(threadId) === 1, 5000);

    const resources = await client.call('resources.list', {});
    const mine = resources.find((entry) => entry.threadId === threadId);
    expect(mine?.live).toHaveLength(1);

    const killed = await client.call('resources.killTree', { threadId });
    expect(killed.killed).toBe(1);

    const gone = await exited;
    expect(gone.pid).toBe(child.pid);
    expect(gone.exitedAt).not.toBeNull();
    expect(harness.core.procs.liveCount(threadId)).toBe(0);

    await finished;
    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitedAt).not.toBeNull();
  }, 30000);

  test('the trace capability says what it can promise on this OS', async () => {
    const client = await harness.connect();
    expect(client.core.trace.mode).toBe('poll');
    expect(client.core.trace.note).toContain('wave 3');
  });
});
