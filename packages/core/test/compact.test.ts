import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkSettingsPatch, DEFAULT_DELEGATION_CONFIG, effectiveCompaction, followedPatch, effectiveSetting, type CompactionPolicy } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { AUTO_COMPACT } from '../src/threads/auto-compact.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import { makeAgent, settled } from './agent-fixture.ts';
let h: TestCore;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { await h.stop(); });
test('coordination instructions never become native compaction arguments', async () => {
  const prompts: string[] = [];
  const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
    prompts.push(ctx.prompt);
    return echoDriver.startTurn(ctx);
  } });
  const client = await h.connect();
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: true });
    const { threadId } = await echoThread(h, client);
    h.core.coordination.configure(threadId, { mode: 'brief', resources: '', remote: false, paused: false });
    let done = client.next('turn.finished', t => t.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'remember this' });
    await done;
    expect(prompts[0]).toContain('boite threads send');
    done = client.next('turn.finished', t => t.threadId === threadId);
    await client.call('threads.compact', { threadId });
    await done;
    expect(prompts[1]).toBe('[compact]');
  } finally { restore(); client.close(); }
});
test('compaction rejects missing sessions and stale selections, and preserves history on success', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const refusal = async () => { try { await client.call('threads.compact', { threadId, expectedSelectionVersion: 0 }); return ''; } catch (e) { return String(e); } };
  expect(await refusal()).toContain('no native session');
  let done = client.next('turn.finished', (t) => t.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: 'remember this' }); await done;
  const before = await client.call('threads.get', { threadId });
  done = client.next('turn.finished', (t) => t.threadId === threadId);
  await client.call('threads.compact', { threadId });
  expect((await done).status).toBe('done');
  const after = await client.call('threads.get', { threadId });
  expect(after.messages[0]).toEqual(before.messages[0]);
  expect(after.sessionId).toBe(before.sessionId);
  expect(after.messages.flatMap(m => m.parts).some(p => p.type === 'compaction')).toBe(true);
  await client.call('threads.update', { threadId, effort: 'low' });
  expect(await refusal()).toContain('selection changed');
  done = client.next('turn.finished', (t) => t.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: '[sleep:200]' });
  try { await client.call('threads.compact', { threadId }); throw new Error('accepted a busy session'); }
  catch (e) { expect(String(e)).toContain('in-flight'); }
  await done; client.close();
});

describe('automatic compaction', () => {
  const saved = { ...AUTO_COMPACT };
  beforeEach(() => { AUTO_COMPACT.settleMs = 20; });
  afterEach(() => { Object.assign(AUTO_COMPACT, saved); });
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  /** One prompt run to its end; echo reads 100 tokens plus one per character. */
  async function turn(client: CoreClient, threadId: string, prompt: string): Promise<void> {
    const done = client.next('turn.finished', t => t.threadId === threadId);
    await client.call('turns.start', { threadId, prompt });
    await done;
  }
  const compactions = async (client: CoreClient, threadId: string) =>
    (await client.call('threads.get', { threadId })).turns.filter(t => t.execution?.operation === 'compact');
  async function quiet(client: CoreClient): Promise<{ threadId: string }> {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    return echoThread(h, client);
  }

  test('the threshold leaves a small context alone and compacts a large one once, as Boite', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: 1000, moments: ['turn-end'] } });
    await turn(client, threadId, 'short');
    await pause(120);
    expect(await compactions(client, threadId)).toEqual([]);

    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    await turn(client, threadId, 'x'.repeat(950));
    expect(await compacted).toMatchObject({ status: 'done', execution: { automatic: true } });
    const thread = await client.call('threads.get', { threadId });
    const turns = thread.turns.filter(t => t.execution?.operation === 'compact');
    expect(turns).toHaveLength(1);
    const opening = thread.messages.find(m => m.turnId === turns[0]!.id && m.role !== 'assistant')!;
    expect(opening.role).toBe('system');
    expect(opening.parts[0]).toMatchObject({ type: 'text', displayText: 'Automatic compaction' });
    expect(thread.messages.flatMap(m => m.parts).find(p => p.type === 'compaction')).toMatchObject({ trigger: 'auto' });
    client.close();
  });

  test('a prompt sent before the delay runs first, and the compaction follows it', async () => {
    AUTO_COMPACT.settleMs = 150;
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['turn-end'] } });
    await turn(client, threadId, 'first');
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    await turn(client, threadId, 'second');
    await compacted;
    // No size condition, so only the rule that a compaction never chains keeps this at one.
    await pause(400);
    const turns = (await client.call('threads.get', { threadId })).turns;
    expect(turns.map(t => t.execution?.operation ?? 'prompt')).toEqual(['prompt', 'prompt', 'compact']);
    client.close();
  });

  test('work left in the background waits for its own moment', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    const task = { id: 'bg1', kind: 'shell' as const, description: 'watch', toolId: null, startedAt: Date.now() };
    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['turn-end'] } });
    h.core.threads.agentState.noteBackground(threadId, [task]);
    await turn(client, threadId, 'start the watch');
    await pause(120);
    expect(await compactions(client, threadId)).toEqual([]);

    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['background'] } });
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    await turn(client, threadId, 'keep watching');
    expect((await compacted).status).toBe('done');
    client.close();
  });

  /**
   * Runs `change` in the core right after the thread's next finished turn arms
   * its timer, in the same tick, so a slow runner cannot let the delay lapse first.
   */
  function onceArmed(threadId: string, change: () => void): void {
    const auto = h.core.threads.autoCompact;
    const original = auto.turnFinished;
    auto.turnFinished = function (thread, finished) {
      original.call(this, thread, finished);
      if (thread.id !== threadId) return;
      auto.turnFinished = original;
      change();
    };
  }

  test('a moment switched off, or work that ended, before the delay is up starts nothing', async () => {
    AUTO_COMPACT.settleMs = 150;
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['turn-end'] } });
    // Echo's cache lives 300 s, so the only moment left is minutes away.
    onceArmed(threadId, () => h.core.settings.set({ autoCompact: { tokens: null, moments: ['cache-expiry'] } }));
    await turn(client, threadId, 'first');
    await pause(400);
    expect(await compactions(client, threadId)).toEqual([]);

    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['background'] } });
    h.core.threads.agentState.noteBackground(threadId, [{ id: 'bg1', kind: 'shell', description: 'watch', toolId: null, startedAt: Date.now() }]);
    onceArmed(threadId, () => h.core.threads.agentState.noteBackground(threadId, []));
    await turn(client, threadId, 'second');
    await pause(400);
    expect(await compactions(client, threadId)).toEqual([]);
    client.close();
  });

  test('an idle thread compacts just before its prompt cache lapses', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['cache-expiry'] } });
    // Echo's cache lives 300 s: the margin puts the moment 200 ms after the turn.
    AUTO_COMPACT.cacheMarginMs = 300_000 - 200;
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    const finished = client.next('turn.finished', t => t.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'hello' });
    const hello = await finished;
    const compaction = await compacted;
    expect(compaction.execution?.automatic).toBe(true);
    // The cache's clock starts when the turn ends: the compaction opens at the
    // cache moment, not before. Polling for "nothing yet" a little after the
    // turn raced the 200 ms on a slow runner.
    expect(compaction.queuedAt).toBeGreaterThanOrEqual(hello.finishedAt! + 300_000 - AUTO_COMPACT.cacheMarginMs);
    client.close();
  });

  test('a thread left above a limit set later compacts once when a client shows it, not at its next prompt', async () => {
    // A thread idle at 212k before a 200k limit existed made its next prompt wait a minute for the agent's own compaction.
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await turn(client, threadId, 'x'.repeat(950));
    await client.call('settings.set', { autoCompact: { tokens: 1000, moments: [] } });
    await pause(120);
    expect(await compactions(client, threadId)).toEqual([]);
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    await client.call('threads.focus', { threadId });
    expect(await compacted).toMatchObject({ status: 'done', execution: { automatic: true } });
    client.close();
  });

  test('a shown thread whose last turn was stopped is left to the user, over its limit or not', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await turn(client, threadId, 'x'.repeat(950));
    const stopped = client.next('turn.finished', t => t.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: `[sleep:5000] ${'x'.repeat(950)}` });
    await client.call('turns.stop', { threadId });
    expect((await stopped).status).toBe('stopped');
    await client.call('settings.set', { autoCompact: { tokens: 1000, moments: [] } });
    expect((await client.call('threads.get', { threadId })).context?.tokens ?? 0).toBeGreaterThanOrEqual(1000);
    await client.call('threads.focus', { threadId });
    await pause(150);
    expect(await compactions(client, threadId)).toEqual([]);
    client.close();
  });

  test('a failed cache keepalive ping does not stand for the conversation\'s last turn', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await turn(client, threadId, 'x'.repeat(950));
    const pinged = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'keepalive');
    h.core.threads.startTurn(threadId, '[error]', [], undefined, 'keepalive');
    expect((await pinged).status).toBe('error');
    await client.call('settings.set', { autoCompact: { tokens: 1000, moments: [] } });
    expect((await client.call('threads.get', { threadId })).context?.tokens ?? 0).toBeGreaterThanOrEqual(1000);
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    await client.call('threads.focus', { threadId });
    expect(await compacted).toMatchObject({ status: 'done', execution: { automatic: true } });
    client.close();
  });

  test('a compaction that keeps more than the limit is not chained by the next looks', async () => {
    // Each look brings a new context reading; without a guard every one compacted again, with no prompt between.
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (ctx.turn.execution?.operation !== 'compact') return echoDriver.startTurn(ctx);
      return echoDriver.startTurn({ ...ctx, context: (use) => ctx.context({ ...use, tokens: 1_500 }) });
    } });
    const client = await h.connect();
    try {
      const { threadId } = await quiet(client);
      await turn(client, threadId, 'x'.repeat(950));
      await client.call('settings.set', { autoCompact: { tokens: 1000, moments: [] } });
      const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
      await client.call('threads.focus', { threadId });
      await compacted;
      expect((await client.call('threads.get', { threadId })).context?.tokens).toBe(1_500);
      for (let look = 0; look < 3; look++) {
        await client.call('threads.focus', { threadId: null });
        await client.call('threads.focus', { threadId });
        await pause(60);
      }
      expect((await compactions(client, threadId)).map(t => t.status)).toEqual(['done']);
    } finally { restore(); client.close(); }
  });

  test('a shown thread whose agent names its compact command only after preparing still compacts', async () => {
    // An ACP session restored after a restart advertises `/compact` once prepared, after the focus that showed it.
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await turn(client, threadId, 'x'.repeat(950));
    await client.call('settings.set', { autoCompact: { tokens: 1000, moments: [] } });
    const threads = h.core.threads;
    const refusal = threads.compactRefusal.bind(threads);
    threads.compactRefusal = () => 'this agent has not advertised a compact command';
    await client.call('threads.focus', { threadId });
    await pause(120);
    expect(await compactions(client, threadId)).toEqual([]);
    threads.compactRefusal = refusal;
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    threads.agentState.noteCommands(threadId, [{ name: 'compact', description: null, hint: null }]);
    expect(await compacted).toMatchObject({ status: 'done', execution: { automatic: true } });
    client.close();
  });

  test('the token limit does not wait for the cache-expiry moment', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: 1000, moments: ['cache-expiry'] } });
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    await turn(client, threadId, 'x'.repeat(950));
    expect((await compacted).status).toBe('done');
    expect((await compactions(client, threadId)).map(t => t.status)).toEqual(['done']);
    client.close();
  });

  test('cache expiry compacts a context below the independent token limit', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: 100_000, moments: ['cache-expiry'] } });
    AUTO_COMPACT.cacheMarginMs = 300_000 - 50;
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    await turn(client, threadId, 'short');
    expect((await compacted).status).toBe('done');
    expect((await compactions(client, threadId)).map(t => t.status)).toEqual(['done']);
    client.close();
  });

  test('working children do not block compaction, and their result waits until it finishes', async () => {
    let finishChild: (() => void) | undefined;
    let compactContext: Parameters<typeof echoDriver.startTurn>[0] | undefined;
    const compact = Promise.withResolvers<Awaited<ReturnType<typeof echoDriver.startTurn>['done']>>();
    const steered: string[] = [];
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (ctx.turn.execution?.operation === 'compact') {
        compactContext = ctx;
        return { done: compact.promise, stop() {}, async steer(text) { steered.push(text); return true; } };
      }
      if (ctx.thread.parentThreadId) {
        const child = Promise.withResolvers<Awaited<ReturnType<typeof echoDriver.startTurn>['done']>>();
        finishChild = () => {
          const id = ctx.emit.startMessage('assistant');
          ctx.emit.part(id, 0, { type: 'text', text: 'child result after compaction' });
          ctx.emit.complete(id, 'complete');
          child.resolve({ status: 'done', sessionId: 'child', usage: null });
        };
        return { done: child.promise, stop() { child.resolve({ status: 'stopped', sessionId: 'child', usage: null }); } };
      }
      return echoDriver.startTurn(ctx);
    } });
    const client = await h.connect();
    try {
      const { threadId } = await quiet(client);
      const { accountId, model } = h.core.threads.require(threadId);
      await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true,
        profiles: [{ id: 'worker', name: 'Worker', providerId: 'echo', accountId, model: model!, effort: null }] } });
      await client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Wait', requestId: 'child' });
      await waitFor(() => finishChild !== undefined);
      await client.call('settings.set', { autoCompact: { tokens: null, moments: ['turn-end'] } });
      await turn(client, threadId, 'parent waits');
      await waitFor(() => compactContext !== undefined);
      expect(h.core.threads.canSteer(threadId)).toBe(false);
      expect(await h.core.threads.steer(threadId, 'must wait')).toBe(false);
      const delivered = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'delegation');
      finishChild!();
      await waitFor(() => h.core.delegation.hasMail(threadId));
      expect(compactContext!.coordination?.()).toBeNull();
      expect(steered).toEqual([]);
      // Disable future automatic compactions so only this held one is observed.
      await client.call('settings.set', { autoCompact: null });
      compact.resolve({ status: 'done', sessionId: compactContext!.sessionId, usage: null });
      expect((await delivered).status).toBe('done');
      expect(h.core.delegation.hasMail(threadId)).toBe(false);
      const thread = await client.call('threads.get', { threadId });
      expect(thread.messages.some(m => m.parts.some(p => p.type === 'text' && p.text.includes('child result after compaction')))).toBe(true);
    } finally { restore(); client.close(); }
  });

  test('an active goal keeps its next iteration: the core does not compact under it', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['turn-end'] } });
    const get = h.core.activity.get.bind(h.core.activity);
    h.core.activity.get = id => id === threadId ? { ...get(id), goal: { objective: 'ship', status: 'active', iterations: 1, error: null } } : get(id);
    await turn(client, threadId, 'work');
    await pause(120);
    expect(await compactions(client, threadId)).toEqual([]);
    client.close();
  });

  test('type policies inherit live defaults, normalize complete overrides and reject malformed policies', async () => {
    const client = await h.connect();
    try {
      const policy: CompactionPolicy = { autoCompact: { tokens: 200_000, moments: ['cache-expiry', 'turn-end', 'turn-end'] }, backgroundCompaction: true };
      const next = await client.call('settings.set', { compactionByType: { subagent: policy } });
      expect(next.compactionByType?.subagent?.autoCompact?.moments).toEqual(['turn-end', 'cache-expiry']);
      for (const bad of [null, [], { worker: policy }, { bot: {} }, { bot: { autoCompact: null } }, { bot: { autoCompact: 'on', backgroundCompaction: false } }, { bot: { autoCompact: null, backgroundCompaction: 1 } }]) {
        expect(checkSettingsPatch({ compactionByType: bad } as never)).toMatchObject({ ok: false, field: 'compactionByType' });
      }
      expect(checkSettingsPatch({ compactionByType: {} })).toEqual({ ok: true, patch: { compactionByType: {} } });
      expect(followedPatch(next, { compactionByType: {} })).toEqual({ compactionByType: {} });
      expect(effectiveSetting(h.core.settings.get(), 'compactionByType')).toEqual(next.compactionByType);
      const common = { autoCompact: { tokens: 3000, moments: [] }, backgroundCompaction: false } satisfies CompactionPolicy;
      const settings = { ...common, compactionByType: next.compactionByType };
      expect(effectiveCompaction(settings, {})).toEqual(common);
      expect(effectiveCompaction(settings, { agentSessionId: 'bot' })).toEqual(common);
      expect(effectiveCompaction(settings, { parentThreadId: 'parent', agentSessionId: 'bot' })).toEqual(next.compactionByType!.subagent!);
    } finally { client.close(); }
  });

  test('a real delegated child inherits the common limit and compaction never delivers a second result', async () => {
    const client = await h.connect();
    try {
      const { threadId } = await quiet(client);
      const { accountId, model } = h.core.threads.require(threadId);
      await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true,
        profiles: [{ id: 'worker', name: 'Worker', providerId: 'echo', accountId, model: model!, effort: null }] } });
      await client.call('settings.set', { autoCompact: { tokens: 1000, moments: [] } });
      const child = await client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'x'.repeat(1100), requestId: 'compact-child' });
      const childId = child.thread.id;
      await waitFor(() => h.core.journal.lastTurn(childId)?.status === 'done');
      await pause(180);
      expect(await compactions(client, childId)).toHaveLength(1);
      await waitFor(() => !h.core.delegation.hasMail(threadId) && h.core.threads.require(threadId).status === 'idle');
      const view = await client.call('delegation.get', { threadId });
      const member = view.agents.find(a => a.thread.id === childId)!;
      expect(member.lastTurn?.execution?.operation).not.toBe('compact');
      expect(member.result).toContain('x'.repeat(1100));
      expect(view.messages.filter(letter => letter.origin === 'result' && letter.from.threadId === childId)).toHaveLength(1);
    } finally { client.close(); }
  });

  test('resolved driver and idle policies differ by type, explicit off and removal restore live inheritance', async () => {
    const client = await h.connect();
    const seen = new Map<string, (number | null | undefined)[]>();
    const restore = setDriver('echo', { ...echoDriver, startTurn(ctx) {
      if (ctx.turn.execution?.operation !== 'compact') seen.set(ctx.thread.id, [...(seen.get(ctx.thread.id) ?? []), ctx.autoCompactTokens?.()]);
      return echoDriver.startTurn(ctx);
    } });
    try {
      const { threadId } = await quiet(client);
      const { threadId: botId } = await makeAgent(h, client);
      await client.call('settings.set', { autoCompact: { tokens: 1000, moments: [] }, compactionByType: {
        agent: { autoCompact: { tokens: 2000, moments: [] }, backgroundCompaction: false },
        bot: { autoCompact: { tokens: null, moments: ['turn-end'] }, backgroundCompaction: false },
      } });
      await turn(client, threadId, 'x'.repeat(1100));
      await turn(client, botId, 'bot work');
      await pause(180);
      expect(await compactions(client, threadId)).toHaveLength(0);
      expect(await compactions(client, botId)).toHaveLength(1);
      expect(seen.get(threadId)?.at(-1)).toBe(2000);
      expect(seen.get(botId)?.at(-1)).toBeNull();
      const before = (await client.call('agents.snapshot', {})).status[0]!.last;
      expect(before?.text).toContain('bot work');
      await client.call('settings.set', { compactionByType: { bot: { autoCompact: null, backgroundCompaction: false } } });
      await turn(client, botId, 'x'.repeat(1100));
      await pause(100);
      expect(await compactions(client, botId)).toHaveLength(1);
      expect(seen.get(botId)?.at(-1)).toBeNull();
      await client.call('settings.set', { autoCompact: { tokens: 1500, moments: [] }, compactionByType: {} });
      await turn(client, botId, 'x'.repeat(1500));
      await pause(180);
      expect(await compactions(client, botId)).toHaveLength(2);
      expect(seen.get(botId)?.at(-1)).toBe(1500);
      expect(settled(h, botId)).toBe(true);
    } finally { restore(); client.close(); }
  });

  test('the setting refuses a threshold out of range and an empty or unknown list of moments', () => {
    expect(checkSettingsPatch({ autoCompact: null }).ok).toBe(true);
    expect(checkSettingsPatch({ autoCompact: { tokens: 200_000, moments: [] } }))
      .toEqual({ ok: true, patch: { autoCompact: { tokens: 200_000, moments: [] } } });
    expect(checkSettingsPatch({ autoCompact: { tokens: 200_000, moments: ['cache-expiry', 'turn-end', 'turn-end'] } }))
      .toEqual({ ok: true, patch: { autoCompact: { tokens: 200_000, moments: ['turn-end', 'cache-expiry'] } } });
    for (const bad of [{ tokens: 999, moments: ['turn-end'] }, { tokens: 1.5e3 + 0.5, moments: ['turn-end'] }, { tokens: null, moments: [] }, { tokens: null, moments: ['mid-turn'] }, 'on']) {
      expect(checkSettingsPatch({ autoCompact: bad as never })).toMatchObject({ ok: false, field: 'autoCompact' });
    }
  });
});
