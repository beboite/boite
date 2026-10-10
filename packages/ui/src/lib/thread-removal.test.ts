import { afterEach, expect, test, vi } from 'vitest';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';
import { archiveThread, reopenLastArchived } from './archive';
import { UNDO_MS, undo } from './undo.svelte';
import { confirm } from './confirm.svelte';
import { deleteThread } from './thread-removal';
import { RpcFailure } from './client';
import { RpcErrorCode } from '@boite/contracts';
import { strings } from './strings';
import { closed } from './archive-history';

const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  undo.dismiss();
  closed.length = 0;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
});
async function ready() {
  const store = new Store();
  stores.push(store);
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  return store;
}

test.each(['archive', 'removeThread'] as const)('%s leaves the open conversation on its project draft', async (action) => {
  const store = await ready();
  await store.open('t-trace');
  const projectId = store.openThread!.projectId;
  await store[action]('t-trace');
  expect(store.openThread).toBeNull();
  expect(store.draft?.projectId).toBe(projectId);
  expect(store.threads.some(thread => thread.id === 't-descriptors')).toBe(true);
  await store.reload();
  expect(store.openThread).toBeNull();
  expect(store.draft?.projectId).toBe(projectId);
});

test.each(['archive', 'removeThread'] as const)('%s in the background preserves the conversation being read', async (action) => {
  const store = await ready();
  await store.open('t-descriptors');
  await store[action]('t-trace');
  expect(store.openThread?.id).toBe('t-descriptors');
  expect(store.draft).toBeNull();
});

test.each([['archive', false], ['removeThread', false], ['removeThread', true]] as const)('%s yields to newer uncached navigation (target rejected: %s)', async (action, rejected) => {
  const store = await ready();
  await store.open('t-trace');
  store.threads = store.threads.filter(thread => thread.id !== 't-descriptors');
  const call = store.client!.call.bind(store.client);
  let releaseMutation!: () => void, releaseOpen!: () => void;
  const mutationGate = new Promise<void>(resolve => { releaseMutation = resolve; });
  const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
  vi.spyOn(store.client!, 'call').mockImplementation(async (method, params) => {
    if (method === (action === 'archive' ? 'threads.archive' : 'threads.remove')) await mutationGate;
    const value = await call(method, params);
    if (method === 'threads.get' && (params as { threadId: string }).threadId === 't-descriptors') {
      await openGate;
      if (rejected) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'Replacement unavailable' });
    }
    return value;
  });
  const mutation = store[action]('t-trace');
  const opening = store.open('t-descriptors');
  try {
    expect(store.openThread?.id).toBe('t-trace');
    releaseMutation(); await mutation;
    releaseOpen(); await opening;
    if (rejected) {
      expect(store.openThread).toBeNull();
      expect(store.draft?.projectId).toBe('p-boite');
      expect(store.error).toBe('Replacement unavailable');
    } else {
      expect(store.openThread?.id).toBe('t-descriptors');
      expect(store.draft).toBeNull();
    }
  } finally { releaseMutation(); releaseOpen(); await Promise.all([mutation, opening]); }
});

test('deleting a just-archived thread removes its undo offer and reopening skips it', async () => {
  const store = await ready();
  expect(await archiveThread(store, 't-trace')).toBe(true);
  const client = store.client!, call = client.call.bind(client);
  const failure = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'threads.archive'
    ? Promise.reject(new Error('Restore temporarily unavailable')) : call(method, params as never));
  expect(await reopenLastArchived(store)).toBe(false);
  expect(store.error).toBe('Restore temporarily unavailable');
  expect(closed.at(-1)?.threadId).toBe('t-trace');
  failure.mockRestore(); store.error = null;
  expect(await reopenLastArchived(store)).toBe(true);
  expect(store.openThread?.id).toBe('t-trace');
  expect(await archiveThread(store, 't-trace')).toBe(true);
  expect(undo.current).not.toBeNull();
  expect(await store.removeThread('t-trace')).toBe(true);
  expect(undo.current).toBeNull();
  const unavailable = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'threads.list'
    ? Promise.reject(new Error('Archive list temporarily unavailable')) : call(method, params as never));
  expect(await reopenLastArchived(store)).toBe(false);
  expect(store.error).toBe('Archive list temporarily unavailable');
  unavailable.mockRestore(); store.error = null;
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

test('deletion toast expires while Settings restoration, reconnect undo and session invalidation still work', async () => {
  const store = await ready();
  const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
  vi.useFakeTimers();
  try {
    expect(await deleteThread(store, store.threads.find(t => t.id === 't-trace')!)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(undo.current).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(undo.current).toBeNull();
    const client = store.client as FakeClient;
    expect(await client.call('threads.deleted', {})).toHaveLength(1);
    expect(await store.restoreDeletedThread('t-trace')).toMatchObject({ id: 't-trace', archived: false });
    expect((await client.call('threads.get', { threadId: 't-trace' })).archived).toBe(false);
    await deleteThread(store, store.threads.find(t => t.id === 't-trace')!);
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

test('a paired phone deletes a conversation and undo brings it back', async () => {
  const store = new Store();
  stores.push(store);
  store.attach(new FakeClient({ delayMs: 0, principal: 'session' }));
  await store.connect();
  expect(store.owner).toBe(false);
  expect(await deleteThread(store, store.threads.find(t => t.id === 't-trace')!)).toBe(true);
  expect(store.threads.some(t => t.id === 't-trace')).toBe(false);
  await undo.take();
  expect(store.threads.some(t => t.id === 't-trace')).toBe(true);
  expect(store.error).toBeNull();
});
