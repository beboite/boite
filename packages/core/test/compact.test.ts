import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkSettingsPatch } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { AUTO_COMPACT } from '../src/threads/auto-compact.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
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
    expect(prompts[0]).toContain('boite agents');
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

  test('an idle thread compacts just before its prompt cache lapses', async () => {
    const client = await h.connect();
    const { threadId } = await quiet(client);
    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['cache-expiry'] } });
    // Echo's cache lives 300 s: the margin puts the moment 200 ms after the turn.
    AUTO_COMPACT.cacheMarginMs = 300_000 - 200;
    await turn(client, threadId, 'hello');
    await pause(80);
    expect(await compactions(client, threadId)).toEqual([]);
    const compacted = client.next('turn.finished', t => t.threadId === threadId && t.execution?.operation === 'compact');
    expect((await compacted).execution?.automatic).toBe(true);
    client.close();
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

  test('the setting refuses a threshold out of range and an empty or unknown list of moments', () => {
    expect(checkSettingsPatch({ autoCompact: null }).ok).toBe(true);
    expect(checkSettingsPatch({ autoCompact: { tokens: 200_000, moments: ['cache-expiry', 'turn-end', 'turn-end'] } }))
      .toEqual({ ok: true, patch: { autoCompact: { tokens: 200_000, moments: ['turn-end', 'cache-expiry'] } } });
    for (const bad of [{ tokens: 999, moments: ['turn-end'] }, { tokens: 1.5e3 + 0.5, moments: ['turn-end'] }, { tokens: null, moments: [] }, { tokens: null, moments: ['mid-turn'] }, 'on']) {
      expect(checkSettingsPatch({ autoCompact: bad as never })).toMatchObject({ ok: false, field: 'autoCompact' });
    }
  });
});
