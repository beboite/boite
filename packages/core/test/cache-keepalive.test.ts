import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG, checkSettingsPatch, type Turn, type Usage } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { SHORT_ANSWERS } from '../src/agent-guide.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { KEEPALIVE_PING_CAP } from '../src/prompt-cache.ts';
import { AUTO_COMPACT, CACHE_KEEPALIVE } from '../src/threads/auto-compact.ts';
import { KEEPALIVE_LABEL, KEEPALIVE_PROMPT, missOf } from '../src/threads/cache-keepalive.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const usage = (read: number, write: number): Usage => ({ inputTokens: 5, outputTokens: 1, cacheReadTokens: read, cacheWriteTokens: write, costUsdEquivalent: null });
const HIT = usage(1_000, 10), MISS = usage(0, 1_010);

/**
 * A fake agent for the parent and its children. The parent's turns end after
 * `turnMs`, report a 300 s cache and a last request `lastRequestMs` before
 * their end; a ping answers `ok` with the usage `pings` hands it, or waits
 * when `holdPings`.
 * A child's turn waits for `finish`.
 */
async function setup(h: TestCore) {
  const children = new Map<string, () => void>();
  const held = new Map<string, () => void>();
  const prompts: string[] = [];
  const state = { pings: [] as Usage[], holdPings: false, holdParent: false, losePings: false, turnMs: 5, lastRequestMs: 100 };
  const restore = setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    const done = Promise.withResolvers<TurnResult>();
    const answer = (text: string, result: Omit<TurnResult, 'status' | 'sessionId'>) => {
      const message = ctx.emit.startMessage('assistant');
      ctx.emit.part(message, 0, { type: 'text', text });
      ctx.emit.complete(message, 'complete');
      done.resolve({ status: 'done', sessionId: 'parent-session', ...result });
    };
    if (ctx.thread.parentThreadId) {
      children.set(ctx.thread.id, () => answer('child result', { usage: null }));
    } else {
      prompts.push(ctx.prompt);
      const ping = ctx.turn.execution?.operation === 'keepalive';
      if (ping && state.losePings) {
        done.resolve({ status: 'error', sessionId: ctx.thread.sessionId, usage: null, error: 'no such session', sessionLost: true });
        return { done: done.promise, stop() {} };
      }
      const finish = () => answer(ping ? 'ok' : 'parent answer', {
        usage: ping ? state.pings.shift() ?? HIT : usage(0, 1_000),
        promptCache: { ttlSeconds: 300, source: 'documented' },
        cacheAt: Date.now() - state.lastRequestMs,
      });
      if ((ping && state.holdPings) || (!ping && state.holdParent)) held.set(ctx.thread.id, finish);
      else setTimeout(finish, state.turnMs);
    }
    return { done: done.promise, stop() { done.resolve({ status: 'stopped', sessionId: 'parent-session', usage: null }); } };
  } });
  const client = await h.connect();
  await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
  const { threadId, accountId } = await echoThread(h, client);
  const model = h.core.threads.require(threadId).model!;
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: 'echo', accountId, model, effort: null }] } });
  let spawned = 0;
  return {
    client, threadId, state, prompts, held,
    /** A child that works until `finish(id)`. */
    async spawn(): Promise<string> {
      const child = await client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Work a while', requestId: `child-${++spawned}` });
      await waitFor(() => children.has(child.thread.id));
      return child.thread.id;
    },
    finish(childId: string) { children.get(childId)!(); },
    /** A turn of the user's, run to its end. */
    async turn(prompt = 'go'): Promise<Turn> {
      const done = client.next('turn.finished', t => t.threadId === threadId && !t.execution?.operation);
      await client.call('turns.start', { threadId, prompt });
      return done;
    },
    async pings(): Promise<Turn[]> {
      return (await client.call('threads.get', { threadId })).turns.filter(t => t.execution?.operation === 'keepalive');
    },
    restore() { restore(); client.close(); },
  };
}

describe('cache keepalive', () => {
  const saved = { ...CACHE_KEEPALIVE };
  const cap = KEEPALIVE_PING_CAP[300]!;
  let h: TestCore;
  beforeEach(async () => {
    h = await startTestCore();
    // The 300 s cache of the fake: a ping 300 ms after the last request.
    CACHE_KEEPALIVE.marginMs = 300_000 - 300;
    CACHE_KEEPALIVE.retryMs = 50;
  });
  afterEach(async () => {
    Object.assign(CACHE_KEEPALIVE, saved);
    (KEEPALIVE_PING_CAP as Record<number, number>)[300] = cap;
    await h.stop();
  });

  test('an independent cache-expiry compaction takes precedence over an earlier keepalive ping', async () => {
    const s = await setup(h);
    const margin = AUTO_COMPACT.cacheMarginMs;
    try {
      s.state.lastRequestMs = 0;
      AUTO_COMPACT.cacheMarginMs = 300_000 - 300;
      CACHE_KEEPALIVE.marginMs = 300_000 - 100;
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 }, autoCompact: { tokens: 100_000, moments: ['cache-expiry'] } });
      await s.spawn();
      const maintenance = s.client.next('turn.started', turn => turn.threadId === s.threadId
        && (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive'));
      const compacted = s.client.next('turn.finished', turn => turn.threadId === s.threadId && turn.execution?.operation === 'compact');
      await s.turn();
      const first = await maintenance;
      expect((await compacted).status).toBe('done');
      // A new ping after compaction is valid; the first maintenance turn must compact.
      expect(first.execution?.operation).toBe('compact');
      expect(s.prompts.filter(prompt => prompt === '[compact]')).toHaveLength(1);
    } finally { AUTO_COMPACT.cacheMarginMs = margin; s.restore(); }
  });

  test('cancelling a planned compaction restores keepalive while the same child still works', async () => {
    const s = await setup(h);
    const margin = AUTO_COMPACT.cacheMarginMs;
    try {
      s.state.lastRequestMs = 0;
      AUTO_COMPACT.cacheMarginMs = 300_000 - 500;
      CACHE_KEEPALIVE.marginMs = 300_000 - 250;
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 }, autoCompact: { tokens: 100_000, moments: ['cache-expiry'] } });
      await s.spawn();
      await s.turn();
      expect(h.core.threads.autoCompact.planned(s.threadId)).toBe(true);
      const pinged = s.client.next('turn.finished', turn => turn.threadId === s.threadId && turn.execution?.operation === 'keepalive');
      await s.client.call('settings.set', { autoCompact: null });
      expect((await pinged).status).toBe('done');
      expect(s.prompts).toContain(KEEPALIVE_PROMPT);
      expect(s.prompts).not.toContain('[compact]');
    } finally { AUTO_COMPACT.cacheMarginMs = margin; s.restore(); }
  });

  test('a thread pings only while it waits on a child, from its last request, as Boite', async () => {
    const s = await setup(h);
    try {
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 } });
      // Nothing to wait for: the cache is left to lapse.
      await s.turn();
      await pause(500);
      expect(await s.pings()).toEqual([]);

      const child = await s.spawn();
      s.state.holdPings = true;
      // From its last request the ping is due 50 ms after the turn ends, from
      // its end 300 ms after: the gap leaves a loaded runner's timers 250 ms.
      // At 100 ms, a macOS x64 run fired it 118 ms late (main ea79290b).
      Object.assign(s.state, { turnMs: 300, lastRequestMs: 250 });
      const pinged = s.client.next('turn.started', t => t.threadId === s.threadId && t.execution?.operation === 'keepalive');
      const real = await s.turn();
      const ping = await pinged;
      Object.assign(s.state, { turnMs: 5, lastRequestMs: 100 });
      const cache = h.core.threads.require(s.threadId).promptCache!;
      // The clock starts at the last request, 250 ms before the turn ended, not at its end.
      expect(cache.at).toBeLessThan(real.finishedAt!);
      expect(ping.queuedAt).toBeGreaterThanOrEqual(cache.at + 300);
      expect(ping.queuedAt).toBeLessThan(real.finishedAt! + 300);
      expect(ping.execution).toMatchObject({ operation: 'keepalive', automatic: true, model: real.execution!.model, effort: real.execution!.effort, accountId: real.execution!.accountId });
      const opening = (await s.client.call('threads.get', { threadId: s.threadId })).messages.find(m => m.turnId === ping.id)!;
      expect(opening.role).toBe('system');
      expect(opening.parts[0]).toMatchObject({ type: 'text', text: KEEPALIVE_PROMPT, displayText: KEEPALIVE_LABEL });
      // Nothing rides on a ping: no guide, no letters, the prompt alone.
      expect(s.prompts.at(-1)).toBe(KEEPALIVE_PROMPT);

      // A hit restarts the clock: the next ping comes from the ping's own request.
      const second = s.client.next('turn.finished', t => t.threadId === s.threadId && t.execution?.operation === 'keepalive' && t.id !== ping.id);
      s.state.holdPings = false;
      s.held.get(s.threadId)!();
      expect((await second).status).toBe('done');

      // The child ends the wait: its result opens a turn, and nothing pings after it.
      const delivered = s.client.next('turn.finished', t => t.threadId === s.threadId && t.execution?.operation === 'delegation');
      s.finish(child);
      await delivered;
      const count = (await s.pings()).length;
      await pause(600);
      expect((await s.pings()).length).toBe(count);
    } finally { s.restore(); }
  });

  test('a miss ends the wait after one ping', async () => {
    const s = await setup(h);
    try {
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 } });
      await s.spawn();
      s.state.pings = [MISS];
      const missed = s.client.next('turn.finished', t => t.threadId === s.threadId && t.execution?.operation === 'keepalive');
      await s.turn();
      expect((await missed).usage).toEqual(MISS);
      await pause(700);
      expect((await s.pings()).length).toBe(1);
    } finally { s.restore(); }
  });

  test('a ping carries none of the guides a real turn gets, and a lost session is not retried on a fresh one', async () => {
    const s = await setup(h);
    try {
      await s.client.call('brain.configure', { path: null, enabled: false, boiteGuide: true });
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 }, shortAnswers: true });
      await s.spawn();
      s.state.losePings = true;
      const lost = s.client.next('turn.finished', t => t.threadId === s.threadId && t.execution?.operation === 'keepalive');
      await s.turn();
      const before = s.prompts.length;
      expect(s.prompts.at(-1)).toContain('Boite coordination');
      expect(s.prompts.at(-1)).toContain(SHORT_ANSWERS);
      expect((await lost).status).toBe('error');
      // One attempt, the prompt alone: no answer style, no coordination, no history replayed on a new session.
      expect(s.prompts.slice(before)).toEqual([KEEPALIVE_PROMPT]);
      await pause(700);
      expect((await s.pings()).length).toBe(1);
      expect(h.core.threads.require(s.threadId).status).toBe('idle');
    } finally { s.restore(); }
  });

  test('the break-even cap bounds the pings of one wait, and a real turn starts a new count', async () => {
    (KEEPALIVE_PING_CAP as Record<number, number>)[300] = 2;
    const s = await setup(h);
    try {
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 } });
      await s.spawn();
      await s.turn();
      await waitFor(() => h.core.journal.listTurns(s.threadId).filter(t => t.execution?.operation === 'keepalive' && t.status === 'done').length === 2);
      await pause(700);
      expect((await s.pings()).length).toBe(2);
      await s.turn();
      await waitFor(() => h.core.journal.listTurns(s.threadId).filter(t => t.execution?.operation === 'keepalive' && t.status === 'done').length === 4);
    } finally { s.restore(); }
  });

  test('the duration of the setting is counted from the end of the last real turn', async () => {
    const s = await setup(h);
    try {
      await s.client.call('settings.set', { cacheKeepalive: { hours: 1 } });
      await s.spawn();
      await s.turn();
      // The wait began an hour ago: the next ping would fall past its end.
      const waits = (h.core.threads.cacheKeepalive as unknown as { waits: Map<string, { since: number }> }).waits;
      waits.get(s.threadId)!.since -= 3_600_000;
      await pause(700);
      expect(await s.pings()).toEqual([]);
    } finally { s.restore(); }
  });

  test('turning the setting off, archiving and a user turn each hold the ping', async () => {
    const s = await setup(h);
    try {
      // The timer is set a minute after the last request, past the end of the test, so none
      // races a hold. Each check makes the ping due and runs the timer's own callback once the
      // hold is done. A ping 200 ms, then 900 ms, after the turn lost to a late archive on a
      // loaded runner (#639).
      const later = 300_000 - 60_000;
      CACHE_KEEPALIVE.marginMs = later;
      const keepalive = h.core.threads.cacheKeepalive as unknown as { waits: Map<string, { timer: unknown }>; fire(threadId: string): void };
      const settled = spyOn(h.core.threads.cacheKeepalive, 'turnFinished');
      const turn = async () => { const before = settled.mock.calls.length; await s.turn(); await waitFor(() => settled.mock.calls.length > before); };
      const armed = () => keepalive.waits.get(s.threadId)?.timer != null;
      const fire = async () => {
        CACHE_KEEPALIVE.marginMs = 300_000;
        try { keepalive.fire(s.threadId); } finally { CACHE_KEEPALIVE.marginMs = later; }
        return (await s.pings()).length;
      };

      // Nothing held, the timer's call sends the ping.
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 } });
      await s.spawn();
      await turn();
      expect(armed()).toBe(true);
      const pinged = s.client.next('turn.finished', t => t.threadId === s.threadId && t.execution?.operation === 'keepalive');
      expect(await fire()).toBe(1);
      expect((await pinged).status).toBe('done');
      await waitFor(armed);

      // Off before the ping comes.
      await s.client.call('settings.set', { cacheKeepalive: null });
      expect(await fire()).toBe(1);

      // Off from the start: nothing is planned.
      await turn();
      expect(armed()).toBe(false);
      expect(await fire()).toBe(1);

      // A user turn that runs past the ping's time: no ping while it runs.
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 } });
      await turn();
      expect(armed()).toBe(true);
      s.state.holdParent = true;
      const started = s.client.next('turn.started', t => t.threadId === s.threadId && !t.execution?.operation);
      await s.client.call('turns.start', { threadId: s.threadId, prompt: 'long' });
      await started;
      expect(await fire()).toBe(1);
      s.state.holdParent = false;
      const ended = settled.mock.calls.length;
      s.held.get(s.threadId)!();
      await waitFor(() => settled.mock.calls.length > ended);
      expect(armed()).toBe(true);

      // Archived before the ping comes.
      await s.client.call('threads.archive', { threadId: s.threadId, archived: true });
      expect(await fire()).toBe(1);
      expect(armed()).toBe(false);
    } finally { s.restore(); }
  });

  test('a child result that comes in during a ping stops it and is delivered', async () => {
    const s = await setup(h);
    try {
      await s.client.call('settings.set', { cacheKeepalive: { hours: 12 } });
      const child = await s.spawn();
      s.state.holdPings = true;
      const running = s.client.next('turn.started', t => t.threadId === s.threadId && t.execution?.operation === 'keepalive');
      await s.turn();
      const ping = await running;
      const stopped = s.client.next('turn.finished', t => t.id === ping.id);
      const delivered = s.client.next('turn.finished', t => t.threadId === s.threadId && t.execution?.operation === 'delegation');
      s.finish(child);
      expect((await stopped).status).toBe('stopped');
      expect((await delivered).status).toBe('done');
      expect(s.prompts.at(-1)).toContain('child result');
      // A ping that gave way pauses nothing and leaves no error on the thread.
      expect(h.core.threads.require(s.threadId).status).toBe('idle');
    } finally { s.restore(); }
  });

  test('the setting takes whole hours from 1 to 24, or null', () => {
    expect(checkSettingsPatch({ cacheKeepalive: null })).toEqual({ ok: true, patch: { cacheKeepalive: null } });
    expect(checkSettingsPatch({ cacheKeepalive: { hours: 12 } })).toEqual({ ok: true, patch: { cacheKeepalive: { hours: 12 } } });
    for (const bad of [{ hours: 0 }, { hours: 25 }, { hours: 1.5 }, {}, 'on']) {
      expect(checkSettingsPatch({ cacheKeepalive: bad as never })).toMatchObject({ ok: false, field: 'cacheKeepalive' });
    }
  });

  test('a ping misses when less than half of what it sent was read from the cache', () => {
    expect(missOf(HIT)).toBeNull();
    expect(missOf(MISS)).toContain('missed');
    expect(missOf(usage(0, 0))).toContain('missed');
    expect(missOf(null)).toContain('no usage');
    // OpenAI writes nothing: a miss shows as fresh input.
    expect(missOf({ inputTokens: 900, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 0, costUsdEquivalent: null })).toContain('missed');
  });
});
