import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ThreadRetry } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext } from '../src/drivers/types.ts';
import { CAPACITY_CONTINUE_PROMPT, CAPACITY_RETRY } from '../src/threads/turn-attempts.ts';
import { LIMIT_RESUME, LIMIT_RESUME_LABEL } from '../src/threads/limit-resume.ts';
import { echoThread, removeDir, rolledBackArchive, startTestCore, waitFor, type TestCore } from './harness.ts';

const delays = [...CAPACITY_RETRY.delaysMs];
const limits = { ...LIMIT_RESUME };
beforeEach(() => {
  CAPACITY_RETRY.delaysMs = [40, 40, 40];
  LIMIT_RESUME.marginMs = 0;
  LIMIT_RESUME.startDelayMs = 0;
});
afterEach(() => {
  CAPACITY_RETRY.delaysMs = delays;
  Object.assign(LIMIT_RESUME, limits);
});

function text(messages: Message[]): string {
  return messages.filter(message => message.role === 'assistant').flatMap(message => message.parts).map(part => part.type === 'text' ? part.text : '').join('');
}

function retryOf(h: TestCore, threadId: string): ThreadRetry | null {
  return h.core.threads.list({ includeArchived: true }).find(thread => thread.id === threadId)?.retry ?? null;
}

test('a turn refused at capacity before writing anything tries again with the same input until it answers', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const seen: ThreadRetry[] = [];
    client.on('thread.updated', thread => { if (thread.id === threadId && thread.retry) seen.push(thread.retry); });
    const turn = await client.call('turns.start', { threadId, prompt: '[capacity:2]hi there' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.turns).toHaveLength(1);
    expect(text(thread.messages)).toContain('hi there');
    expect(text(thread.messages)).not.toContain(CAPACITY_CONTINUE_PROMPT);
    expect(seen.map(retry => [retry.kind, retry.attempt, retry.attempts])).toEqual([['capacity', 1, 3], ['capacity', 2, 3]]);
    expect(thread.retry).toBeNull();
  } finally { await h.stop(); }
});

test('a retry after a refusal that wrote nothing resumes from the totals the refused attempt left', async () => {
  const h = await startTestCore();
  const attempts: TurnContext[] = [];
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      attempts.push(ctx);
      return { stop() {}, done: Promise.resolve(attempts.length === 1
        ? { status: 'error', sessionId: 'native-session', usage: null, error: 'at capacity', refusal: { kind: 'capacity' }, agentTotals: { costUsd: 0.1, tokens: 60 } }
        : { status: 'done', sessionId: 'native-session', usage: null }) };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'hi' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.sessionBefore).toEqual({ costUsd: 0.1, tokens: 60 });
    expect(h.core.journal.getTurn(turn.id)?.agentTotals).toEqual({ costUsd: 0.1, tokens: 60 });
  } finally { await h.stop(); restore(); }
});

test('a turn refused at capacity after writing continues with a short prompt instead of resending the request', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'first half [capacity:1] second half' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    const answer = text((await client.call('threads.get', { threadId })).messages);
    // The echo agent writes back the prompt it gets: the second try got the continue prompt, not the request.
    expect(answer).toContain('first half');
    expect(answer).toContain(CAPACITY_CONTINUE_PROMPT);
    expect(answer).not.toContain('second half');
  } finally { await h.stop(); }
});

test('after three tries at capacity the turn fails with the refusal', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: '[capacity:9]never' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'error');
    expect(h.core.journal.getTurn(turn.id)?.error).toContain('at capacity');
    expect(retryOf(h, threadId)).toBeNull();
    await h.core.logs.flush();
    const attempts = (await h.core.logs.query({ limit: 500 })).filter(record => record.threadId === threadId && record.event === 'turn.attempt.started');
    expect(attempts.length).toBe(4);
  } finally { await h.stop(); }
});

test('Stop ends a capacity wait at once and Cancel fails the turn with the refusal', async () => {
  const h = await startTestCore();
  try {
    CAPACITY_RETRY.delaysMs = [60_000, 60_000, 60_000];
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const stopped = await client.call('turns.start', { threadId, prompt: '[capacity:9]stop me' });
    await waitFor(() => retryOf(h, threadId)?.kind === 'capacity');
    expect(retryOf(h, threadId)?.at).toBeGreaterThan(Date.now() + 50_000);
    expect(h.core.journal.getThread(threadId)?.status).toBe('running');
    await client.call('turns.stop', { threadId });
    await waitFor(() => h.core.journal.getTurn(stopped.id)?.status === 'stopped');
    expect(retryOf(h, threadId)).toBeNull();

    const cancelled = await client.call('turns.start', { threadId, prompt: '[capacity:9]cancel me' });
    await waitFor(() => retryOf(h, threadId)?.turnId === cancelled.id);
    expect(await client.call('turns.cancelRetry', { threadId })).toEqual({ cancelled: true });
    await waitFor(() => h.core.journal.getTurn(cancelled.id)?.status === 'error');
    expect(h.core.journal.getTurn(cancelled.id)?.error).toContain('at capacity');
    expect(await client.call('turns.cancelRetry', { threadId })).toEqual({ cancelled: false });
  } finally { await h.stop(); }
});

test('a usage limit failure plans nothing while automatic resume is off', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: '[usage-limit:60000]' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'error');
    await Bun.sleep(50);
    expect(retryOf(h, threadId)).toBeNull();
  } finally { await h.stop(); }
});

test('a thread stopped by a usage limit resumes once at the reset, never for a window already reset or twice for one window', async () => {
  const h = await startTestCore({ settings: { autoResumeLimitedThreads: true } });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);

    const expired = await client.call('turns.start', { threadId, prompt: '[usage-limit:-1000]' });
    await waitFor(() => h.core.journal.getTurn(expired.id)?.status === 'error');
    await Bun.sleep(50);
    expect(retryOf(h, threadId)).toBeNull();

    const limited = await client.call('turns.start', { threadId, prompt: '[usage-limit:400]' });
    await waitFor(() => retryOf(h, threadId)?.kind === 'usage-limit');
    const planned = retryOf(h, threadId)!;
    expect(planned.turnId).toBe(limited.id);
    expect(planned.resetsAt).toBeGreaterThan(Date.now());
    await waitFor(() => h.core.journal.listTurns(threadId).length === 3);
    const resumed = h.core.journal.listTurns(threadId)[2]!;
    expect(resumed.execution?.operation).toBe('resume');
    await waitFor(() => h.core.journal.getTurn(resumed.id)?.status === 'done');
    const opening = (await client.call('threads.get', { threadId })).messages.find(message => message.turnId === resumed.id && message.role === 'system');
    expect(opening?.parts[0]?.type === 'text' ? opening.parts[0].displayText : null).toBe(LIMIT_RESUME_LABEL);

    // Within two minutes of the window it already resumed after: no second resume.
    const again = await client.call('turns.start', { threadId, prompt: '[usage-limit:600]' });
    await waitFor(() => h.core.journal.getTurn(again.id)?.status === 'error');
    await Bun.sleep(900);
    expect(retryOf(h, threadId)).toBeNull();
    expect(h.core.journal.listTurns(threadId)).toHaveLength(4);
  } finally { await h.stop(); }
});

test('a cache ping neither cancels a planned usage limit resume nor stands for the turn it resumes', async () => {
  const h = await startTestCore({ settings: { autoResumeLimitedThreads: true } });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const limited = await client.call('turns.start', { threadId, prompt: '[usage-limit:500]' });
    await waitFor(() => retryOf(h, threadId)?.turnId === limited.id);
    const ping = h.core.threads.startTurn(threadId, 'ping', { kind: 'keepalive' });
    await waitFor(() => h.core.journal.getTurn(ping.id)?.status === 'done');
    expect(retryOf(h, threadId)).toMatchObject({ kind: 'usage-limit', turnId: limited.id });
    await waitFor(() => h.core.journal.listTurns(threadId).length === 3);
    expect(h.core.journal.listTurns(threadId)[2]!.execution?.operation).toBe('resume');
  } finally { await h.stop(); }
});

test('a planned resume is cancelled by a new message, by Stop and by Cancel', async () => {
  const h = await startTestCore({ settings: { autoResumeLimitedThreads: true } });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const plan = async (prompt: string) => {
      const turn = await client.call('turns.start', { threadId, prompt });
      await waitFor(() => retryOf(h, threadId)?.turnId === turn.id);
    };

    await plan('[usage-limit:600000]');
    const answered = await client.call('turns.start', { threadId, prompt: 'never mind' });
    await waitFor(() => h.core.journal.getTurn(answered.id)?.status === 'done');
    expect(retryOf(h, threadId)).toBeNull();

    await plan('[usage-limit:700000]');
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect(retryOf(h, threadId)).toBeNull();

    await plan('[usage-limit:800000]');
    expect(await client.call('turns.cancelRetry', { threadId })).toEqual({ cancelled: true });
    expect(retryOf(h, threadId)).toBeNull();
    expect(h.core.journal.listTurns(threadId)).toHaveLength(4);
  } finally { await h.stop(); }
});

test('a resume refuses a thread whose model changed since the limit', async () => {
  const h = await startTestCore({ settings: { autoResumeLimitedThreads: true } });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: '[usage-limit:300]' });
    await waitFor(() => retryOf(h, threadId)?.turnId === turn.id);
    const thread = h.core.journal.getThread(threadId)!;
    h.core.journal.putThread({ ...thread, model: 'another-model' });
    await waitFor(() => retryOf(h, threadId) === null, 3000);
    await Bun.sleep(100);
    expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
    await h.core.logs.flush();
    const cancelled = (await h.core.logs.query({ limit: 500 })).filter(record => record.threadId === threadId && record.event === 'limit-resume.cancelled');
    expect(cancelled[0]?.message).toContain('model changed');
  } finally { await h.stop(); }
});

test('an archive that rolls back keeps the planned resume, which still fires', async () => {
  const h = await startTestCore({ settings: { autoResumeLimitedThreads: true } });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: '[usage-limit:800]' });
    await waitFor(() => retryOf(h, threadId)?.turnId === turn.id);
    rolledBackArchive(h, threadId);
    expect([h.core.threads.require(threadId).archived, retryOf(h, threadId)?.turnId]).toEqual([false, turn.id]);
    await waitFor(() => h.core.journal.listTurns(threadId)[1]?.execution?.operation === 'resume', 5000);
  } finally { await h.stop(); }
});

test('an archived thread keeps the usage window it resumed after across a restart', async () => {
  // The test owns the directory, so it outlives the first core's stop.
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-resume-archived-'));
  let h: TestCore | undefined, next: Core | undefined;
  try {
    h = await startTestCore({ dataDir, settings: { autoResumeLimitedThreads: true } });
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.archive', { threadId });
    // Unarchived later, a failure in the same window must not resume a second time.
    h.core.journal.setSetting('resumes', { [threadId]: { handled: 'trn_old', resumedWindow: 1_234 } });
    await h.stop();

    next = new Core({ dataDir, token: h.token });
    expect((next.journal.getSetting('resumes') as Record<string, unknown>)[threadId]).toEqual({ resumedWindow: 1_234 });
  } finally {
    await next?.close();
    await h?.stop();
    await removeDir(dataDir);
  }
});

test('a planned resume survives a core restart and fires on the next core', async () => {
  const h = await startTestCore({ settings: { autoResumeLimitedThreads: true } });
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const turn = await client.call('turns.start', { threadId, prompt: '[usage-limit:1500]' });
  await waitFor(() => retryOf(h, threadId)?.turnId === turn.id);
  client.close();
  await h.server.stop();
  await h.core.close();

  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(next.threads.list({}).find(thread => thread.id === threadId)?.retry?.kind).toBe('usage-limit');
    await waitFor(() => next.journal.listTurns(threadId).length === 2, 5000);
    const resumed = next.journal.listTurns(threadId)[1]!;
    await waitFor(() => next.journal.getTurn(resumed.id)?.status === 'done');
    expect(resumed.execution?.operation).toBe('resume');
  } finally {
    await next.close();
    await removeDir(h.dataDir);
  }
});
