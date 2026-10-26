import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import { makeAgent } from './agent-fixture.ts';
import type { CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { AUTO_COMPACT } from '../src/threads/auto-compact.ts';
import { BACKGROUND_COMPACT } from '../src/threads/background-compact.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import type { TurnContext } from '../src/drivers/types.ts';

let h: TestCore;
const saved = { compact: { ...AUTO_COMPACT }, background: { ...BACKGROUND_COMPACT } };
beforeEach(async () => {
  AUTO_COMPACT.settleMs = 20;
  // Echo reads 100 tokens plus one per character: a limit of 1000 starts a copy from 850.
  BACKGROUND_COMPACT.minTokens = 0;
  h = await startTestCore();
});
afterEach(async () => {
  await h.stop();
  Object.assign(AUTO_COMPACT, saved.compact);
  Object.assign(BACKGROUND_COMPACT, saved.background);
});

/** The copy runs under its own key, so its turns are told apart from the thread's. */
const isCopy = (ctx: TurnContext) => ctx.thread.id.endsWith('~compact');

async function turn(client: CoreClient, threadId: string, prompt: string): Promise<void> {
  const done = client.next('turn.finished', t => t.threadId === threadId);
  await client.call('turns.start', { threadId, prompt });
  await done;
}
const compactions = async (client: CoreClient, threadId: string) =>
  (await client.call('threads.get', { threadId })).turns.filter(t => t.execution?.operation === 'compact');
async function setUp(client: CoreClient): Promise<string> {
  await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
  const { threadId } = await echoThread(h, client);
  await client.call('settings.set', { autoCompact: { tokens: 1000, moments: ['turn-end'] }, backgroundCompaction: true });
  return threadId;
}

describe('background compaction', () => {
  test('a copy compacts near the limit and the thread takes it at the next pause, then sends what came after', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prompts: string[] = [];
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (!isCopy(ctx)) { prompts.push(ctx.prompt); return echoDriver.startTurn(ctx); }
      // The copy waits until the conversation went on without it.
      let stopped = false;
      const done = gate.then(() => stopped ? { status: 'stopped' as const, sessionId: ctx.sessionId, usage: null } : echoDriver.startTurn(ctx).done);
      return { done, stop: () => { stopped = true; release(); } };
    } });
    const client = await h.connect();
    try {
      const threadId = await setUp(client);
      await turn(client, threadId, 'x'.repeat(760));
      const source = h.core.journal.getThread(threadId)!;
      expect(source.context?.tokens).toBe(860);
      const cut = h.core.journal.lastTurn(threadId)!.id;
      // The thread stays free while its copy runs.
      await turn(client, threadId, `meanwhile ${'y'.repeat(760)}`);
      expect(h.core.journal.getThread(threadId)!.sessionId).toBe(source.sessionId);
      release();
      await waitFor(() => (h.core.journal.getThread(threadId)!.sessionGeneration ?? 0) === (source.sessionGeneration ?? 0) + 1);
      const swapped = await client.call('threads.get', { threadId });
      // The fork the copy compacted, taken without a compaction turn.
      expect(swapped.sessionId).toBe(`${source.sessionId}~${cut}`);
      expect(swapped.context?.tokens).toBe(300);
      expect(await compactions(client, threadId)).toEqual([]);
      const divider = swapped.messages.flatMap(m => m.parts).find(p => p.type === 'compaction');
      expect(divider).toMatchObject({ type: 'compaction', trigger: 'auto', postTokens: 300, background: true });

      await turn(client, threadId, 'next request');
      const carried = prompts.at(-1)!;
      expect(carried).toContain('<recent-history>');
      expect(carried).toContain('meanwhile');
      expect(carried).not.toContain('x'.repeat(760));
      expect(carried.endsWith('Current user request:\nnext request')).toBe(true);
      // Once carried, the tail is not sent again.
      await turn(client, threadId, 'after that');
      expect(prompts.at(-1)).toBe('after that');
    } finally { release(); restore(); client.close(); }
  });

  test('the limit waits for a copy still running rather than compacting while it does', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (!isCopy(ctx)) return echoDriver.startTurn(ctx);
      return { done: gate.then(() => echoDriver.startTurn(ctx).done), stop: () => release() };
    } });
    const client = await h.connect();
    try {
      const threadId = await setUp(client);
      await turn(client, threadId, 'x'.repeat(760));
      const generation = h.core.journal.getThread(threadId)!.sessionGeneration ?? 0;
      // 1050 tokens, within the tail a copy may leave behind.
      await turn(client, threadId, 'z'.repeat(950));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await compactions(client, threadId)).toEqual([]);
      release();
      await waitFor(() => (h.core.journal.getThread(threadId)!.sessionGeneration ?? 0) === generation + 1);
      expect(await compactions(client, threadId)).toEqual([]);
    } finally { release(); restore(); client.close(); }
  });

  test('a copy that fails leaves the limit to the blocking compaction', async () => {
    let copies = 0;
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (!isCopy(ctx)) return echoDriver.startTurn(ctx);
      copies += 1;
      return { done: Promise.resolve({ status: 'error' as const, sessionId: ctx.sessionId, usage: null, error: 'copy refused' }), stop: () => undefined };
    } });
    const client = await h.connect();
    try {
      const threadId = await setUp(client);
      await turn(client, threadId, 'x'.repeat(760));
      await waitFor(() => copies === 1);
      const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
      await turn(client, threadId, 'x'.repeat(950));
      expect(await compacted).toMatchObject({ status: 'done', execution: { automatic: true } });
      const thread = await client.call('threads.get', { threadId });
      expect(thread.messages.flatMap(m => m.parts).some(p => p.type === 'compaction' && p.background === true)).toBe(false);
    } finally { restore(); client.close(); }
  });

  test('per-type background switches cover real children and bots, and a policy change cancels the old copy', async () => {
    const copies: TurnContext[] = [];
    let stops = 0;
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (!isCopy(ctx)) return echoDriver.startTurn({ ...ctx, context: use => ctx.context({ ...use, tokens: 860 }) });
      copies.push(ctx);
      const held = Promise.withResolvers<Awaited<ReturnType<typeof echoDriver.startTurn>['done']>>();
      return { done: held.promise, stop() { stops++; held.resolve({ status: 'stopped', sessionId: ctx.sessionId, usage: null }); } };
    } });
    const client = await h.connect();
    try {
      const parentId = await setUp(client);
      await client.call('settings.set', { autoCompact: null, backgroundCompaction: false });
      const { threadId: botId } = await makeAgent(h, client);
      const { accountId, model } = h.core.threads.require(parentId);
      await client.call('delegation.configure', { threadId: parentId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true,
        profiles: [{ id: 'worker', name: 'Worker', providerId: 'echo', accountId, model: model!, effort: null }] } });
      const child = await client.call('delegation.spawn', { threadId: parentId, profileId: 'worker', task: 'initialize', requestId: 'background-child' });
      await waitFor(() => h.core.threads.require(child.thread.id).status === 'idle' && h.core.threads.require(parentId).status === 'idle');
      const policy = { autoCompact: { tokens: 1000, moments: [] }, backgroundCompaction: true };
      await client.call('settings.set', { compactionByType: { subagent: policy, bot: { ...policy, backgroundCompaction: false } } });
      await turn(client, child.thread.id, 'x'.repeat(760));
      await turn(client, botId, 'x'.repeat(760));
      await Bun.sleep(100);
      expect(copies.map(ctx => ctx.thread.id)).toEqual([`${child.thread.id}~compact`]);
      // The copy is maintenance: it carries no native threshold or parent delivery callback.
      expect(copies[0]!.autoCompactTokens?.()).toBeNull();
      await client.call('settings.set', { compactionByType: { subagent: { ...policy, autoCompact: { tokens: 2000, moments: [] } }, bot: policy } });
      expect(stops).toBe(1);
      await turn(client, botId, 'x'.repeat(760));
      await waitFor(() => copies.length === 2);
      expect(copies[1]!.thread.id).toBe(`${botId}~compact`);
      await client.call('settings.set', { compactionByType: {} });
      expect(stops).toBe(2);
    } finally { restore(); client.close(); }
  });

  test('off, a thread near its limit starts no copy', async () => {
    let copies = 0;
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (isCopy(ctx)) copies += 1;
      return echoDriver.startTurn(ctx);
    } });
    const client = await h.connect();
    try {
      const threadId = await setUp(client);
      await client.call('settings.set', { backgroundCompaction: false });
      await turn(client, threadId, 'x'.repeat(760));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(copies).toBe(0);
    } finally { restore(); client.close(); }
  });
});
