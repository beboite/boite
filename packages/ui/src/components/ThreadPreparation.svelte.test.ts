import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import ThreadPreparation from './ThreadPreparation.svelte';

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
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: 't-trace' }));
  flushSync(() => { store.page = 'settings'; });
  await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: null }));
  flushSync(() => { store.page = 'chat'; });
  await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('threads.focus', { threadId: 't-trace' }));
});

test('an obscured phone conversation does not prepare an agent', async () => {
  const { store, call } = await machine();
  component(store, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: null }));
  expect(call.mock.calls.some(([method, params]) => method === 'threads.focus' && (params as { threadId: string | null }).threadId === 't-trace')).toBe(false);
});

test('a reconnect reasserts focus on the owning socket', async () => {
  const { store, client, call } = await machine();
  component(store);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: 't-trace' }));
  call.mockClear();
  client.drop();
  flushSync();
  await client.restore();
  flushSync();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('threads.focus', { threadId: 't-trace' }));
});
