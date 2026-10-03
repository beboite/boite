import { inspectJournal } from '../src/journal/integrity.ts';
import { describe, expect, test } from 'bun:test';
import type { Message, Turn } from '@boite/contracts';
import { holdAccountTurns, echoThread, removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { Core } from '../src/core.ts';
import { startServer } from '../src/server.ts';
import { connect } from '../src/client.ts';

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
  test('held prompts survive a second restart and resume once or discard by exact identity', async () => {
    const harness = await startTestCore();
    const client = await harness.connect();
    const first = await echoThread(harness, client, 'resume');
    const second = await echoThread(harness, client, 'discard');
    holdAccountTurns(harness);
    const input = { threadId: first.threadId, prompt: 'retained input', clientRequestId: 'recovery_request_01' };
    const turn = await client.call('turns.start', input);
    const discarded = await client.call('turns.start', { threadId: second.threadId, prompt: 'not sent' });
    crash(harness);
    client.close();
    await stopWithoutCleanup(harness);
    const recovered = new Core({ dataDir: harness.dataDir, token: harness.token });
    const held = recovered.journal.getTurn(turn.id)!;
    await recovered.close();
    const next = new Core({ dataDir: harness.dataDir, token: harness.token });
    const server = startServer({ core: next, host: '127.0.0.1', port: 0 });
    const reader = await connect(server.url, harness.token);
    try {
      expect(next.journal.getTurn(turn.id)).toEqual(held);
      expect(next.scheduler.state().queued.map(entry => entry.turnId)).toEqual([turn.id, discarded.id]);
      expect(next.scheduler.state().running).toEqual([]);
      await expect(reader.call('threads.archive', { threadId: first.threadId, onlyIfIdle: true })).rejects.toThrow('pending');
      expect(next.journal.getTurn(turn.id)).toEqual(held);
      expect((await reader.call('turns.start', input)).id).toBe(turn.id);
      expect(next.threads.get(first.threadId).messages).toHaveLength(1);
      await expect(reader.call('turns.recover', { threadId: first.threadId, turnId: discarded.id, action: 'discard' })).rejects.toThrow('turnId');
      const selection = next.threads.require(first.threadId);
      next.journal.putThread({ ...selection, model: 'future-picker-choice', selectionVersion: 1 });
      let starts = 0;
      const off = next.bus.onAny((name, payload) => { if (name === 'turn.started' && (payload as Turn).id === turn.id) starts += 1; });
      await reader.call('turns.recover', { threadId: first.threadId, turnId: turn.id, action: 'resume' });
      await reader.call('turns.recover', { threadId: first.threadId, turnId: turn.id, action: 'resume' });
      await waitFor(() => next.journal.getTurn(turn.id)?.status === 'done');
      off();
      expect(starts).toBe(1);
      expect(next.journal.getTurn(turn.id)?.execution).toEqual(turn.execution);
      expect(next.threads.require(first.threadId)).toMatchObject({ model: 'future-picker-choice', status: 'idle' });
      expect(next.threads.get(first.threadId).messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(next.journal.turnRequest(first.threadId, input.clientRequestId)?.turn_id).toBe(turn.id);
      expect(await reader.call('turns.recover', { threadId: second.threadId, turnId: discarded.id, action: 'discard' })).toMatchObject({ id: discarded.id, status: 'stopped' });
      expect(await reader.call('turns.recover', { threadId: second.threadId, turnId: discarded.id, action: 'resume' })).toMatchObject({ id: discarded.id, status: 'stopped' });
      expect(next.threads.get(second.threadId).messages).toHaveLength(1);
      expect(next.scheduler.state().queued).toEqual([]);
      expect((await reader.call('threads.archive', { threadId: second.threadId, onlyIfIdle: true })).archived).toBe(true);
      expect(inspectJournal(next.journal, { limit: 500 }).issues).toEqual([]);
    } finally {
      reader.close();
      await server.stop();
      await next.close();
      await removeDir(harness.dataDir);
    }
  });
  test('a busy thread with no unfinished turn becomes idle', async () => {
    const harness = await startTestCore();
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client);
      harness.core.journal.db.query("UPDATE threads SET status = 'running' WHERE id = ?").run(threadId);
      harness.core.threads.recoverStuckTurns();
      expect(harness.core.threads.get(threadId).status).toBe('idle');
    } finally { await harness.stop(); }
  });
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

  test('an unsent turn is held after a crash without losing its identity or input', async () => {
    // Account login admission keeps the second turn queued until the crash.
    const harness = await startTestCore();
    const client = await harness.connect();
    const running = await echoThread(harness, client, 'running thread');
    const waiting = await echoThread(harness, client, 'queued thread');

    const started = client.next('turn.started', (turn) => turn.threadId === running.threadId, 10000);
    await client.call('turns.start', { threadId: running.threadId, prompt: '[sleep:60000] never lands' });
    await started;

    holdAccountTurns(harness);
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
      expect(recovered?.status).toBe('queued');
      expect(recovered?.queueHold?.reason).toBe('core-restarted');
      expect(recovered?.execution).toEqual(turn.execution);
      expect(recovered?.startedAt).toBeNull();
      expect(thread.status).toBe('queued');
      expect(thread.messages).toHaveLength(1);
      expect(lastMessage(thread.messages)?.role).toBe('user');
      expect(next.scheduler.state().running).toEqual([]);
      expect(next.scheduler.state().queued).toMatchObject([{ turnId: turn.id, queueHold: { reason: 'core-restarted' } }]);
      next.scheduler.onSettingsChanged();
      expect(next.threads.get(waiting.threadId).turns[0]?.status).toBe('queued');

      // Work that may have reached the provider is still recovered as an error.
      const other = next.threads.get(running.threadId);
      expect(other.turns[0]?.status).toBe('error');
      expect(other.turns[0]?.error).toContain('while this turn was running');
      expect(other.status).toBe('idle');
    } finally {
      await next.close();
      await removeDir(harness.dataDir);
    }
  });

  test('an asynchronous question still open is answerable on the next start', async () => {
    const harness = await startTestCore();
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const skipped = await echoThread(harness, client, 'skipped thread');
    for (const id of [threadId, skipped.threadId]) {
      const finished = client.next('turn.finished', (turn) => turn.threadId === id, 10000);
      await client.call('turns.start', { threadId: id, prompt: 'hello' });
      await finished;
    }
    const { questionId } = await client.call('questions.ask', { threadId, text: 'Which file?', options: ['Parser', 'Renderer'] });
    const gone = await client.call('questions.ask', { threadId: skipped.threadId, text: 'Skipped?' });
    await client.call('questions.skip', { threadId: skipped.threadId, questionId: gone.questionId });

    client.close();
    await stopWithoutCleanup(harness);

    const next = new Core({ dataDir: harness.dataDir, token: harness.token });
    try {
      expect(next.threads.cards.listQuestions().map((question) => question.id)).toEqual([questionId]);
      next.threads.cards.answerQuestion({ threadId, questionId, optionIds: ['2'] });
      const card = next.threads.get(threadId).messages.flatMap((message) => message.parts).find((part) => part.type === 'question');
      expect(card).toMatchObject({ questionId, answer: { optionIds: ['2'] } });
      expect(next.threads.cards.listQuestions()).toEqual([]);
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
