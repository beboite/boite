import { expect, test } from 'bun:test';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

test.each([false, true])('restart coalesces mode changes and respects Stop=%s', async stop => {
  const h = await startTestCore();
  const attempts: TurnContext[] = [];
  const stopped = Promise.withResolvers<TurnResult>();
  let stops = 0;
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      attempts.push(ctx);
      return {
        done: attempts.length === 1 ? stopped.promise : Promise.resolve({ status: 'done', sessionId: 'native-session', usage: {
          inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: 0.2,
        } }),
        stop() { stops++; },
      };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => attempts.length === 1);
    for (const permissionMode of ['bypassPermissions', 'yolo', 'default'] as const) {
      await client.call('threads.update', { threadId, permissionMode });
    }
    expect(stops).toBe(1);
    if (stop) await client.call('turns.stop', { threadId });
    stopped.resolve({ status: 'stopped', sessionId: 'native-session', usage: {
      inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0, costUsdEquivalent: 0.1,
    } });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt !== null);
    const saved = h.core.journal.getTurn(turn.id)!;
    expect(attempts).toHaveLength(stop ? 1 : 2);
    expect(saved.status).toBe(stop ? 'stopped' : 'done');
    expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
    expect(h.core.journal.listMessages(threadId).filter(message => message.role === 'user')).toHaveLength(1);
    if (!stop) {
      expect(attempts[1]!.thread.permissionMode).toBe('default');
      expect(attempts[1]!.sessionId).toBe('native-session');
      expect(attempts[1]!.prompt).toContain('Do not repeat completed work');
      expect(attempts[1]!.sessionBefore).toEqual({ costUsd: 0.1, tokens: 6 });
      expect(saved.usage).toMatchObject({ inputTokens: 7, outputTokens: 10, cacheReadTokens: 1 });
      expect(saved.usage!.costUsdEquivalent).toBeCloseTo(0.3);
    }
  } finally { await h.stop(); restore(); }
});

test('a mode setter that never answers cannot keep a completed turn running', async () => {
  const h = await startTestCore();
  const done = Promise.withResolvers<TurnResult>();
  let called = false;
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      return {
        done: done.promise, stop() {},
        setPermissionMode() { called = true; return new Promise<boolean>(() => {}); },
      };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    await client.call('threads.update', { threadId, permissionMode: 'yolo' });
    await waitFor(() => called);
    done.resolve({ status: 'done', sessionId: null, usage: null });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
  } finally { await h.stop(); restore(); }
});

test('a stalled live setter resumes the still-running task with the requested mode', async () => {
  const h = await startTestCore();
  const done = Promise.withResolvers<TurnResult>();
  const modes: string[] = [];
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      modes.push(ctx.thread.permissionMode);
      return {
        done: modes.length === 1 ? done.promise : Promise.resolve({ status: 'done', sessionId: 'native-session', usage: null }),
        stop() { done.resolve({ status: 'stopped', sessionId: 'native-session', usage: null }); },
        setPermissionMode() { return new Promise<boolean>(() => {}); },
      };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => modes.length === 1);
    await client.call('threads.update', { threadId, permissionMode: 'yolo' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    expect(modes).toEqual(['default', 'yolo']);
  } finally { await h.stop(); restore(); }
});
