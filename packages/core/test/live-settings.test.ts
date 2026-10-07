import { expect, test } from 'bun:test';
import { setDriver } from '../src/drivers/index.ts';
import type { LiveTurnSettings, TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

/** An echo model with the two speeds a native tier has, beside its shipped effort levels. */
function withSpeeds(h: Awaited<ReturnType<typeof startTestCore>>): void {
  h.core.providers.require('echo').models.find(model => model.id === 'echo')!.speeds = [{ id: 'fast', label: 'Fast' }];
}

test('an effort or speed change reaches the running turn and its execution snapshot, never a restart', async () => {
  const h = await startTestCore();
  withSpeeds(h);
  const attempts: TurnContext[] = [];
  const done = Promise.withResolvers<TurnResult>();
  const changes: LiveTurnSettings[] = [];
  let stops = 0;
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      attempts.push(ctx);
      return {
        done: done.promise, stop() { stops++; },
        // This agent takes an effort on a running turn and has no live speed.
        applySettings(change) {
          changes.push(change);
          return Promise.resolve('effort' in change ? { effort: change.effort } : {});
        },
      };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.update', { threadId, model: 'echo', effort: 'low' });
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    expect(h.core.journal.getTurn(turn.id)?.execution).toMatchObject({ effort: 'low', speed: null });

    await client.call('threads.update', { threadId, effort: 'high' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.execution?.effort === 'high');
    await client.call('threads.update', { threadId, speed: 'fast' });
    await waitFor(() => changes.length === 2);
    expect(changes).toEqual([{ effort: 'high' }, { speed: 'fast' }]);

    done.resolve({ status: 'done', sessionId: 'native', usage: null });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    // The declined speed stays what the turn ran on; the thread keeps the selection for the next one.
    expect(h.core.journal.getTurn(turn.id)?.execution).toMatchObject({ effort: 'high', speed: null });
    expect(h.core.threads.require(threadId)).toMatchObject({ effort: 'high', speed: 'fast' });
    expect(attempts).toHaveLength(1);
    expect(stops).toBe(0);
  } finally { await h.stop(); restore(); }
});

test('changes made while a setter is busy collapse into the last selection', async () => {
  const h = await startTestCore();
  const done = Promise.withResolvers<TurnResult>();
  const first = Promise.withResolvers<LiveTurnSettings>();
  const changes: LiveTurnSettings[] = [];
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      return {
        done: done.promise, stop() {},
        applySettings(change) {
          changes.push(change);
          return changes.length === 1 ? first.promise : Promise.resolve(change);
        },
      };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.update', { threadId, model: 'echo', effort: 'low' });
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    await client.call('threads.update', { threadId, effort: 'high' });
    await waitFor(() => changes.length === 1);
    // Back to the level the turn is on, then up again, all behind the first call.
    await client.call('threads.update', { threadId, effort: 'low' });
    await client.call('threads.update', { threadId, effort: 'high' });
    first.resolve({ effort: 'high' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.execution?.effort === 'high');
    done.resolve({ status: 'done', sessionId: null, usage: null });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    expect(changes).toEqual([{ effort: 'high' }]);
  } finally { await h.stop(); restore(); }
});

test('a setter that never answers or throws leaves the turn running on what it started with', async () => {
  const h = await startTestCore();
  const done = Promise.withResolvers<TurnResult>();
  let calls = 0;
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      return {
        done: done.promise, stop() {},
        applySettings() {
          calls++;
          return calls === 1 ? Promise.reject(new Error('unknown method')) : new Promise<LiveTurnSettings>(() => {});
        },
      };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.update', { threadId, model: 'echo', effort: 'low' });
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    await client.call('threads.update', { threadId, effort: 'high' });
    await waitFor(() => calls === 1);
    await client.call('threads.update', { threadId, effort: null });
    await waitFor(() => calls === 2);
    done.resolve({ status: 'done', sessionId: null, usage: null });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    expect(h.core.journal.getTurn(turn.id)?.execution?.effort).toBe('low');
    expect(h.core.threads.require(threadId).effort).toBeNull();
  } finally { await h.stop(); restore(); }
});

test('a selection that also changes the model waits for the next turn whole', async () => {
  const h = await startTestCore();
  const done = Promise.withResolvers<TurnResult>();
  let calls = 0;
  const provider = h.core.providers.require('echo');
  provider.models.push({ ...provider.models.find(model => model.id === 'echo')!, id: 'echo-two', name: 'Echo two' });
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      return { done: done.promise, stop() {}, applySettings(change) { calls++; return Promise.resolve(change); } };
    },
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.update', { threadId, model: 'echo', effort: 'low' });
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    await client.call('threads.update', { threadId, model: 'echo-two', effort: 'high' });
    // The other model's scale means nothing to the turn still running on the first one.
    await client.call('threads.update', { threadId, effort: 'low' });
    done.resolve({ status: 'done', sessionId: null, usage: null });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    expect(calls).toBe(0);
    expect(h.core.journal.getTurn(turn.id)?.execution).toMatchObject({ model: 'echo', effort: 'low' });
  } finally { await h.stop(); restore(); }
});
