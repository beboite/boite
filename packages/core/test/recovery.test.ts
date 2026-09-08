import { describe, expect, test } from 'bun:test';
import type { Message, Turn } from '@boite/contracts';
import { echoThread, removeDir, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import { Core } from '../src/core.ts';

/**
 * A killed core has no chance to finish its turns: it stops writing mid-turn.
 * Closing the journal under a running turn leaves exactly that state behind,
 * `turn.started` written and no `turn.finished`, which is what the next core has
 * to clean up.
 */
function crash(harness: TestCore): void {
  harness.core.journal.close();
}

/** The first core is put down without deleting its data directory. */
async function stopWithoutCleanup(harness: TestCore): Promise<void> {
  await harness.server.stop();
  await harness.core.close();
  delete process.env.BOITE_DATA_DIR;
}

function lastMessage(messages: Message[]): Message | undefined {
  return messages.at(-1);
}

function turnOf(turns: Turn[], turnId: string): Turn | undefined {
  return turns.find((turn) => turn.id === turnId);
}

describe('crash recovery', () => {
  test('a turn left running by a dead core is an error on the next start', async () => {
    const harness = await startTestCore();
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);

    const started = client.next('turn.started', (turn) => turn.threadId === threadId, 10000);
    const turn = await client.call('turns.start', { threadId, prompt: '[sleep:60000] never lands' });
    await started;
    expect((await client.call('threads.get', { threadId })).status).toBe('running');

    crash(harness);
    client.close();
    await stopWithoutCleanup(harness);

    const next = new Core({ dataDir: harness.dataDir, token: harness.token });
    try {
      const thread = next.threads.get(threadId);
      const recovered = turnOf(thread.turns, turn.id);
      expect(recovered?.status).toBe('error');
      expect(recovered?.error).toContain('The core stopped');
      expect(recovered?.error).toContain('while this turn was running');
      expect(recovered?.finishedAt).not.toBeNull();
      expect(thread.status).toBe('idle');

      const last = lastMessage(thread.messages);
      expect(last?.turnId).toBe(turn.id);
      expect(last?.state).toBe('error');
      const error = last?.parts.find((part) => part.type === 'error');
      expect(error).toBeDefined();
      if (error?.type === 'error') expect(error.message).toContain('The core stopped');
      expect(thread.messages.some((message) => message.state === 'streaming')).toBe(false);
    } finally {
      await next.close();
      await removeDir(harness.dataDir);
    }
  });

  test('a turn left queued by a dead core is an error on the next start', async () => {
    // One turn at a time, so the second one never leaves the queue.
    const harness = await startTestCore({ settings: { maxConcurrentTurns: 1 } });
    const client = await harness.connect();
    const running = await echoThread(harness, client, 'running thread');
    const waiting = await echoThread(harness, client, 'queued thread');

    const started = client.next('turn.started', (turn) => turn.threadId === running.threadId, 10000);
    await client.call('turns.start', { threadId: running.threadId, prompt: '[sleep:60000] never lands' });
    await started;

    const turn = await client.call('turns.start', { threadId: waiting.threadId, prompt: 'waits in the queue' });
    expect(turn.status).toBe('queued');
    expect((await client.call('threads.get', { threadId: waiting.threadId })).status).toBe('queued');

    crash(harness);
    client.close();
    await stopWithoutCleanup(harness);

    const next = new Core({ dataDir: harness.dataDir, token: harness.token });
    try {
      const thread = next.threads.get(waiting.threadId);
      const recovered = turnOf(thread.turns, turn.id);
      expect(recovered?.status).toBe('error');
      expect(recovered?.error).toContain('The core stopped');
      expect(recovered?.error).toContain('while this turn was queued');
      expect(thread.status).toBe('idle');

      const last = lastMessage(thread.messages);
      expect(last?.turnId).toBe(turn.id);
      expect(last?.state).toBe('error');
      const error = last?.parts.find((part) => part.type === 'error');
      expect(error).toBeDefined();
      if (error?.type === 'error') expect(error.message).toContain('The core stopped');

      // The turn that was running when the core died is recovered too, with its
      // own reason, and both threads are free again.
      const other = next.threads.get(running.threadId);
      expect(other.turns[0]?.status).toBe('error');
      expect(other.turns[0]?.error).toContain('while this turn was running');
      expect(other.status).toBe('idle');
    } finally {
      await next.close();
      await removeDir(harness.dataDir);
    }
  });

  test('a core that starts on a clean journal recovers nothing', async () => {
    const harness = await startTestCore();
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'one two three' });
    expect((await finished).status).toBe('done');

    client.close();
    await stopWithoutCleanup(harness);

    const next = new Core({ dataDir: harness.dataDir, token: harness.token });
    try {
      expect(next.threads.recoverStuckTurns()).toBe(0);
      const thread = next.threads.get(threadId);
      expect(thread.turns[0]?.status).toBe('done');
      expect(thread.status).toBe('idle');
      expect(lastMessage(thread.messages)?.state).toBe('complete');
    } finally {
      await next.close();
      await removeDir(harness.dataDir);
    }
  });
});
