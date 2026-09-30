import { afterEach, expect, test, vi } from 'vitest';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';
import { archiveThread, reopenLastArchived } from './archive';
import { undo } from './undo.svelte';
import { confirm } from './confirm.svelte';
import { deleteThread } from './thread-removal';
import { RpcFailure } from './client';
import { RpcErrorCode } from '@boite/contracts';
import { strings } from './strings';

const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
  const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
  vi.useFakeTimers();
  try {
    expect(await deleteThread(store, store.threads.find(t => t.id === 't-trace')!)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(undo.current).not.toBeNull();
    const client = store.client as FakeClient;
    client.drop(); client.restore();
    await store.reload();
    await undo.take();
    expect((await client.call('threads.deleted', {}))).toEqual([]);
    expect((await client.call('threads.get', { threadId: 't-trace' })).archived).toBe(false);
    await deleteThread(store, store.threads.find(t => t.id === 't-trace')!);
    expect(undo.current).not.toBeNull();
    client.core!.startedAt++;
    client.drop(); client.restore();
    await store.reload();
    expect(undo.current).toBeNull();
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

test('an older core keeps the conversation and explains which machine needs an update', async () => {
  const store = await ready();
  const call = store.client!.call.bind(store.client);
  vi.spyOn(store.client!, 'call').mockImplementation((method, params) => method === 'threads.remove'
    ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method threads.remove' }))
    : call(method, params));
  expect(await store.removeThread('t-trace')).toBe(false);
  expect(store.threads.some(t => t.id === 't-trace')).toBe(true);
  expect(store.error).toBe(strings.sidebar.deleteUnavailable);
  expect(undo.current).toBeNull();
});
