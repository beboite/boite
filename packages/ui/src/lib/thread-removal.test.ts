import { afterEach, expect, test, vi } from 'vitest';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';
import { archiveThread, reopenLastArchived } from './archive';
import { undo } from './undo.svelte';

const stores: Store[] = [];
afterEach(() => {
  undo.dismiss();
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
});
async function ready() {
  const store = new Store();
  stores.push(store);
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  return store;
}

test('deleting a just-archived thread removes its undo offer and reopening skips it', async () => {
  const store = await ready();
  expect(await archiveThread(store, 't-trace')).toBe(true);
  expect(undo.current).not.toBeNull();
  expect(await store.removeThread('t-trace')).toBe(true);
  expect(undo.current).toBeNull();
  expect(await reopenLastArchived(store)).toBe(true);
  expect(store.openThread?.id).toBe('t-parser');
  expect(store.error).toBeNull();
});

test('deletion clears the owning machine composer and leaves colliding IDs on another machine intact', async () => {
  const first = await ready();
  const second = await ready();
  first.editComposerText('t-trace', 'First machine');
  second.editComposerText('t-trace', 'Second machine');
  await second.open('t-trace');
  expect(await first.removeThread('t-trace')).toBe(true);
  expect(first.threads.some(t => t.id === 't-trace')).toBe(false);
  expect(first.composerStates['t-trace']).toBeUndefined();
  expect(second.threads.some(t => t.id === 't-trace')).toBe(true);
  expect(second.openThread?.id).toBe('t-trace');
  expect(second.composerStates['t-trace']?.text).toBe('Second machine');
  const history = await second.client!.call('threads.get', { threadId: 't-trace' });
  await first.restoreDeletedThread('t-trace');
  expect(first.threads.some(t => t.id === 't-trace')).toBe(true);
  expect((await first.client!.call('threads.get', { threadId: 't-trace' })).messages).toEqual(history.messages);
  expect(second.openThread?.id).toBe('t-trace');
});

test('deletion undo stays offered past the archive timeout and survives a temporary disconnect', async () => {
  const store = await ready();
  const { deleteThread } = await import('./thread-removal');
  const { confirm } = await import('./confirm.svelte');
  vi.spyOn(confirm, 'ask').mockResolvedValueOnce(true);
  vi.useFakeTimers();
  try {
    expect(await deleteThread(store, store.threads.find(t => t.id === 't-trace')!)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(undo.current).not.toBeNull();
    const client = store.client as FakeClient;
    client.drop(); client.restore();
    await store.reload();
    await undo.take();
    expect((await client.call('threads.deleted', {}))).toEqual([]);
    expect((await client.call('threads.get', { threadId: 't-trace' })).archived).toBe(false);
    vi.spyOn(confirm, 'ask').mockResolvedValueOnce(true);
    await deleteThread(store, store.threads.find(t => t.id === 't-trace')!);
    expect(undo.current).not.toBeNull();
    client.core!.startedAt++;
    client.drop(); client.restore();
    await store.reload();
    expect(undo.current).toBeNull();
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});
