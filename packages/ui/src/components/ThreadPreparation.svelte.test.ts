import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import ThreadPreparation from './ThreadPreparation.svelte';
import { rightPanel } from '../lib/right-panel.svelte';
import * as journal from '../lib/draft-journal';

const unprotected = { protectedThreadIds: [], protectAllThreads: false };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function machine() {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const call = vi.spyOn(client, 'call');
  cleanups.push(() => { store.detach(); client.close(); });
  return { store, client, call };
}

function component(store: Store, visible = true) {
  const target = document.createElement('div');
  document.body.append(target);
  let component: ReturnType<typeof mount>;
  flushSync(() => { component = mount(ThreadPreparation, { target, props: { store, visible } }); });
  cleanups.push(async () => { await unmount(component); target.remove(); });
  return target;
}

test('only the visible conversation is focused; settings and destruction release it', async () => {
  const { store, call } = await machine();
  component(store);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: 't-trace', ...unprotected }));
  flushSync(() => { store.page = 'settings'; });
  await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, ...unprotected }));
  flushSync(() => { store.page = 'chat'; });
  await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: 't-trace', ...unprotected }));
});

test('an obscured phone conversation does not prepare an agent', async () => {
  const { store, call } = await machine();
  component(store, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: null, ...unprotected }));
  expect(call.mock.calls.some(([method, params]) => method === 'threads.focus' && (params as { threadId: string | null }).threadId === 't-trace')).toBe(false);
});

test('a reconnect reasserts focus on the owning socket', async () => {
  const { store, client, call } = await machine();
  component(store);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: 't-trace', ...unprotected }));
  call.mockClear();
  client.drop();
  flushSync();
  await client.restore();
  flushSync();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: 't-trace', ...unprotected }));
});

test('a hidden machine protects parked prompts and unsaved files until they are cleared', async () => {
  const { store, call } = await machine();
  const panel = rightPanel.for(store.threadKey('t-trace'));
  cleanups.push(() => rightPanel.forget(store.threadKey('t-trace')));
  component(store, false);
  flushSync(() => { store.composerStates['t-tests'] = { text: 'parked', attachments: [], queued: [], sending: false, paused: false }; });
  await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, protectedThreadIds: ['t-tests'], protectAllThreads: false }));
  flushSync(() => { panel.keepDraft('file:notes.txt', 'unsaved'); });
  await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, protectedThreadIds: ['t-tests', 't-trace'], protectAllThreads: false }));
  flushSync(() => { store.composerStates['t-tests']!.text = ''; panel.keepDraft('file:notes.txt', null); });
  await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, ...unprotected }));
});

test('an unread draft journal protects unknown replies until the owning store can read it', async () => {
  const read = vi.spyOn(journal, 'readDraftJournal').mockRejectedValueOnce(new Error('IndexedDB unavailable'));
  try {
    const { store, call } = await machine();
    component(store, false);
    await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, protectedThreadIds: [], protectAllThreads: true }));
    const other = await machine();
    component(other.store, false);
    await vi.waitFor(() => expect(other.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, ...unprotected }));
    const replacement = new FakeClient({ delayMs: 0 });
    const replacementCall = vi.spyOn(replacement, 'call');
    cleanups.push(() => replacement.close());
    store.attach(replacement);
    await store.connect();
    flushSync();
    await vi.waitFor(() => expect(replacementCall.mock.calls.filter(([method]) => method === 'threads.focus').at(-1))
      .toEqual(['threads.focus', { threadId: null, ...unprotected }]));
  } finally { read.mockRestore(); }
});
