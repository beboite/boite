import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcErrorCode } from '@boite/contracts';
import { Core } from '../src/core.ts';
import type { CoreClient } from '../src/client.ts';
import { deleteExpiredDoneThreads } from '../src/threads/done-retention.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const DAY = 86_400_000;
let harness: TestCore, client: CoreClient;
beforeEach(async () => { harness = await startTestCore(); client = await harness.connect(); });
afterEach(async () => { await harness.stop(); });

test('done expiry starts on Mark done, keeps manual archives, and resets after restoring', async () => {
  expect((await client.call('settings.get', {})).threadDoneRetentionDays).toBe(3);
  const { threadId } = await echoThread(harness, client);
  const { threadId: manual } = await echoThread(harness, client, 'manual archive');
  const { threadId: unread } = await echoThread(harness, client, 'unread completed turn');
  const old = Date.now() - 10 * DAY;
  for (const id of [threadId, manual, unread]) {
    harness.core.journal.putThread({ ...harness.core.threads.require(id), createdAt: old, updatedAt: old, unread: true });
  }
  const done = await client.call('threads.archive', { threadId, onlyIfIdle: true });
  expect(done.doneAt).toBeGreaterThan(old);
  expect((await client.call('threads.archive', { threadId: manual })).doneAt).toBeNull();
  await deleteExpiredDoneThreads(harness.core);
  expect(harness.core.journal.getThread(threadId)).not.toBeNull();
  // Later reads and renames never move the deadline.
  await client.call('threads.markRead', { threadId });
  await client.call('threads.update', { threadId, title: 'renamed done' });
  expect(harness.core.threads.require(threadId).doneAt).toBe(done.doneAt);
  expect((await client.call('threads.archive', { threadId, archived: false })).doneAt).toBeNull();
  await client.call('threads.archive', { threadId, onlyIfIdle: true });
  expect(harness.core.threads.require(threadId).doneAt).toBeGreaterThanOrEqual(done.doneAt!);
  harness.core.journal.db.query('UPDATE threads SET done_at = ? WHERE id = ?').run(Date.now() - 4 * DAY, threadId);
  const removed: string[] = [];
  client.on('thread.removed', event => { removed.push(event.threadId); });
  await deleteExpiredDoneThreads(harness.core);
  await waitFor(() => removed.includes(threadId));
  expect(harness.core.journal.getThread(threadId)).toBeNull();
  expect(harness.core.journal.getThread(manual)?.archived).toBe(true);
  expect(harness.core.journal.getThread(unread)?.archived).toBe(false);
  expect((await client.call('threads.deleted', {})).map(row => row.id)).toContain(threadId);
  const restored = await client.call('threads.restore', { threadId });
  expect(restored.archived).toBe(true);
  expect(restored.doneAt).toBeUndefined();
  await deleteExpiredDoneThreads(harness.core);
  expect(harness.core.journal.getThread(threadId)).not.toBeNull();
});

test('expiry observes the exact deadline, disabled retention and active descendants', async () => {
  const { threadId } = await echoThread(harness, client);
  const { threadId: childId } = await echoThread(harness, client, 'child');
  harness.core.journal.putThread({ ...harness.core.threads.require(childId), parentThreadId: threadId });
  await client.call('threads.archive', { threadId, onlyIfIdle: true });
  const now = Date.now();
  harness.core.journal.db.query('UPDATE threads SET done_at = ? WHERE id = ?').run(now - 3 * DAY, threadId);
  const clock = spyOn(Date, 'now').mockReturnValue(now - 1);
  try {
    await deleteExpiredDoneThreads(harness.core);
    expect(harness.core.journal.getThread(threadId)).not.toBeNull();
    clock.mockReturnValue(now);
    await client.call('settings.set', { threadDoneRetentionDays: 0 });
    await deleteExpiredDoneThreads(harness.core);
    expect(harness.core.journal.getThread(threadId)).not.toBeNull();
    await client.call('settings.set', { threadDoneRetentionDays: 3 });
    harness.core.journal.putThread({ ...harness.core.threads.require(childId), status: 'waiting' });
    await deleteExpiredDoneThreads(harness.core);
    expect(harness.core.journal.getThread(threadId)).not.toBeNull();
    harness.core.journal.putThread({ ...harness.core.threads.require(childId), status: 'idle' });
    await deleteExpiredDoneThreads(harness.core);
    expect(harness.core.journal.getThread(threadId)).toBeNull();
    expect(harness.core.journal.getThread(childId)).toBeNull();
  } finally { clock.mockRestore(); }
});

test('startup uses persisted done dates and settings after time offline', async () => {
  const { threadId } = await echoThread(harness, client);
  const turn = await client.call('turns.start', { threadId, prompt: 'kept history' });
  await waitFor(() => harness.core.journal.getTurn(turn.id)?.status === 'done');
  await client.call('settings.set', { threadDoneRetentionDays: 7 });
  await client.call('threads.archive', { threadId, onlyIfIdle: true });
  harness.core.journal.db.query('UPDATE threads SET done_at = ? WHERE id = ?').run(Date.now() - 4 * DAY, threadId);
  const dir = mkdtempSync(join(tmpdir(), 'boite-done-restart-'));
  harness.core.journal.db.query('VACUUM INTO ?').run(join(dir, 'journal.db'));
  let restarted = new Core({ dataDir: dir, token: harness.token });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(restarted.journal.getThread(threadId)).not.toBeNull();
    restarted.settings.set({ threadDoneRetentionDays: 3 });
    await restarted.close();
    restarted = new Core({ dataDir: dir, token: harness.token });
    await waitFor(() => restarted.journal.getThread(threadId) === null);
    expect(restarted.journal.listDeletedThreads().map(row => row.id)).toContain(threadId);
    expect(restarted.journal.listMessages(threadId).length).toBeGreaterThan(0);
  } finally { await restarted.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('done retention rejects invalid delays through RPC', async () => {
  for (const value of [-1, 0.5, 3651, null, '3']) {
    expect(await client.call('settings.set', { threadDoneRetentionDays: value as number }).catch(error => error))
      .toMatchObject({ rpc: { code: RpcErrorCode.InvalidParams, data: { field: 'threadDoneRetentionDays' } } });
  }
});

test('failed cleanup retains the done deadline so startup retries removal', async () => {
  const { threadId } = await echoThread(harness, client);
  await client.call('threads.archive', { threadId, onlyIfIdle: true });
  const doneAt = Date.now() - 4 * DAY;
  harness.core.journal.db.query('UPDATE threads SET done_at = ? WHERE id = ?').run(doneAt, threadId);
  const stop = spyOn(harness.core.procs, 'stopAndWait').mockRejectedValueOnce(new Error('cleanup interrupted'));
  try {
    await expect(deleteExpiredDoneThreads(harness.core)).rejects.toThrow('cleanup interrupted');
    expect(harness.core.journal.getThread(threadId)?.doneAt).toBe(doneAt);
    expect(harness.core.journal.listDeletedThreads()).toEqual([]);
  } finally { stop.mockRestore(); }
  const dir = mkdtempSync(join(tmpdir(), 'boite-done-retry-'));
  harness.core.journal.db.query('VACUUM INTO ?').run(join(dir, 'journal.db'));
  const restarted = new Core({ dataDir: dir, token: harness.token });
  try {
    await waitFor(() => restarted.journal.getThread(threadId) === null);
    expect(restarted.journal.listDeletedThreads().map(row => row.id)).toContain(threadId);
    expect(restarted.threads.restoreDeleted(threadId).doneAt).toBeUndefined();
    await deleteExpiredDoneThreads(restarted);
    expect(restarted.journal.getThread(threadId)).not.toBeNull();
  } finally { await restarted.close(); rmSync(dir, { recursive: true, force: true }); }
});
