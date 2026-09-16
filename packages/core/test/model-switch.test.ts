import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { setDriver } from '../src/drivers/index.ts';
import { continuationInput } from '../src/continuation.ts';
import { Journal } from '../src/journal.ts';
import { join } from 'node:path';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

async function setup() {
  const client = await h.connect();
  const { threadId, accountId } = await echoThread(h, client);
  h.core.journal.putAccount({ ...h.core.accounts.require(accountId), id: 'second-account', label: 'Second' });
  return { client, threadId, accountId };
}

test('account switching keeps the thread, carries prior exchanges and never reuses the old native session', async () => {
  const { client, threadId, accountId } = await setup();
  const seen: TurnContext[] = [];
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      seen.push(ctx);
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: `remember ${ctx.prompt}` });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: `native-${seen.length}`, usage: null }) };
    },
  });
  const run = async (prompt: string) => {
    const turn = await client.call('turns.start', { threadId, prompt });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
    expect(h.core.journal.getTurn(turn.id)?.error).toBeNull();
    expect(h.core.journal.getTurn(turn.id)?.status).toBe('done');
  };
  await run('the passwordless project uses blue widgets');
  const switched = await client.call('threads.update', { threadId, accountId: 'second-account', model: 'echo' });
  expect(switched.accountId).toBe('second-account');
  expect(switched.sessionId).toBeNull();
  await run('continue');
  expect(seen[1]?.prompt).toContain('blue widgets');
  expect(seen[1]?.sessionId).toBeNull();
  await client.call('threads.update', { threadId, accountId, model: 'echo' });
  await run('back again');
  expect(seen[2]?.sessionId).toBeNull();
  expect(seen[2]?.prompt).toContain('continue');
  expect(h.core.threads.list({})).toHaveLength(1);
  const messages = h.core.threads.get(threadId).messages.filter((m) => m.role === 'user');
  expect(messages[1]?.parts).toEqual([{ type: 'text', text: 'continue' }]);
});

test('a queued turn keeps its original account and late completion cannot attach its session to the new selection', async () => {
  const { client, threadId, accountId } = await setup();
  h.core.settings.set({ maxConcurrentTurns: 1 });
  const blocker = await client.call('threads.create', {
    projectId: h.core.threads.require(threadId).projectId, providerId: 'echo', accountId,
  });
  const seen: TurnContext[] = [];
  let finish!: (value: TurnResult) => void;
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      seen.push(ctx);
      if (ctx.thread.id === blocker.id) {
        return { done: new Promise((resolve) => { finish = resolve; }), stop: () => finish({ status: 'stopped', sessionId: null, usage: null }) };
      }
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: 'old-native', usage: null }) };
    },
  });
  await client.call('turns.start', { threadId: blocker.id, prompt: 'block' });
  const queued = await client.call('turns.start', { threadId, prompt: 'queued on first account' });
  await client.call('threads.update', { threadId, accountId: 'second-account', model: 'echo' });
  finish({ status: 'done', sessionId: null, usage: null });
  await waitFor(() => h.core.journal.getTurn(queued.id)?.status === 'done');
  expect(seen[1]?.account.id).toBe(accountId);
  expect(h.core.threads.require(threadId).accountId).toBe('second-account');
  expect(h.core.threads.require(threadId).sessionId).toBeNull();
  expect(h.core.journal.getTurn(queued.id)?.execution?.accountId).toBe(accountId);
});

test('a stale model selection is refused before a prompt is journalled', async () => {
  const { client, threadId } = await setup();
  await client.call('threads.update', { threadId, accountId: 'second-account', model: 'echo', expectedSelectionVersion: 0 });
  let error = '';
  try { await client.call('turns.start', { threadId, prompt: 'stale', expectedSelectionVersion: 0 }); }
  catch (e) { error = String(e); }
  expect(error).toContain('selection changed');
  expect(h.core.threads.get(threadId).messages).toHaveLength(0);
});

test('continuation reads beyond the UI page, bounds long history and excludes reasoning and old grants', async () => {
  const { threadId } = await setup();
  for (let i = 0; i < 160; i++) {
    h.core.journal.putMessage({
      id: `history-${i}`, threadId, turnId: 'historical', role: i % 2 ? 'assistant' : 'user', state: 'complete', createdAt: i,
      parts: [
        { type: 'text', text: `exchange-${i}: ${'abc '.repeat(300)}` },
        { type: 'thinking', text: 'private reasoning must not transfer' },
        { type: 'permission', requestId: 'old-approval', toolName: 'write', decision: 'allow' },
      ],
    });
  }
  const result = continuationInput(h.core.journal, threadId, 'next', { prompt: 'Current request', attachments: [] }, h.core.providers.require('echo'));
  expect(result.prompt).toContain('exchange-0:');
  expect(result.prompt).toContain('exchange-159:');
  expect(result.prompt).toContain('older messages omitted');
  expect(result.prompt).not.toContain('private reasoning must not transfer');
  expect(result.prompt).not.toContain('old-approval');
  expect(result.prompt.length).toBeLessThan(78_000);
  expect(result.prompt.endsWith('Current request')).toBe(true);
});

test('historical images travel before current attachments and unsupported image history is refused', async () => {
  const { threadId } = await setup();
  h.core.journal.putMessage({ id: 'image', threadId, turnId: 'old', role: 'user', state: 'complete', createdAt: 1,
    parts: [{ type: 'image', mimeType: 'image/png', data: 'aGlzdG9yeQ==', alt: 'diagram.png' }],
  });
  const provider = h.core.providers.require('echo');
  const input = { prompt: 'Compare', attachments: [{ kind: 'image' as const, mimeType: 'image/png' as const, data: 'bmV3', name: 'new.png' }] };
  const result = continuationInput(h.core.journal, threadId, 'new', input, provider);
  expect(result.attachments.map((image) => image.name)).toEqual(['diagram.png', 'new.png']);
  expect(() => continuationInput(h.core.journal, threadId, 'new', input, { ...provider, capabilities: { ...provider.capabilities, images: false } })).toThrow('historical images');
});

test('migration preserves legacy native sessions and persists new selections and turn execution', async () => {
  const { client, threadId } = await setup();
  const path = join(h.dataDir, 'migration.db');
  const legacy = new Journal(path);
  legacy.putThread({ ...h.core.threads.require(threadId), sessionId: 'legacy-session' });
  legacy.db.exec('DROP TABLE turn_requests; ALTER TABLE threads DROP COLUMN speed; ALTER TABLE threads DROP COLUMN session_generation; ALTER TABLE threads DROP COLUMN selection_version; ALTER TABLE turns DROP COLUMN execution; PRAGMA user_version = 8;');
  legacy.close();
  const migrated = new Journal(path);
  try {
    expect(migrated.getThread(threadId)?.sessionId).toBe('legacy-session');
    expect(migrated.getThread(threadId)?.sessionGeneration).toBe(0);
  } finally { migrated.close(); }
  await client.call('threads.update', { threadId, accountId: 'second-account', model: 'echo' });
  const turn = await client.call('turns.start', { threadId, prompt: 'persist' });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
  const reader = new Journal(join(h.dataDir, 'journal.db'));
  try {
    expect(reader.getThread(threadId)?.accountId).toBe('second-account');
    expect(reader.getThread(threadId)?.sessionGeneration).toBe(1);
    expect(reader.getTurn(turn.id)?.execution?.accountId).toBe('second-account');
  } finally { reader.close(); }
});
