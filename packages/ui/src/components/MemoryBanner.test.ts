import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { MemoryStatus } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import MachinesPage from './MachinesPage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const clients: FakeClient[] = [];
const stores: Store[] = [];
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined; workspace.machines = [];
  for (const store of stores.splice(0)) store.detach();
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
});
async function machine(id = 'one') {
  const client = new FakeClient({ delayMs: 0, coreId: id }); clients.push(client);
  const store = new Store(); stores.push(store); store.attach(client);
  await store.connect(); await store.refreshMemory();
  workspace.machines = [...workspace.machines, { id, label: id, store }];
  workspace.active = store;
  return { client, store };
}

test('memory pressure and process stops never create a persistent global notice', async () => {
  const { client } = await machine();
  mounted = mount(MachinesPage, { target: document.body, props: { mobile: true } }); await settle();
  expect(document.querySelector('[data-testid=memory-banner]')).toBeNull();
  client.emitMemory({ threadId: null, kind: 'pressure', state: 'critical', at: 1 }); await settle();
  expect(document.querySelector('[data-testid=memory-banner]')).toBeNull();
  client.emitMemory({ threadId: 't-trace', kind: 'killed', reason: 'budget', limitBytes: 19456 * 1048576, state: 'critical', exe: 'cargo', at: 2 }); await settle();
  expect(document.querySelector('[data-testid=memory-banner]')).toBeNull();
  client.emitMemory({ threadId: null, kind: 'pressure', state: 'ok', at: 3 }); await settle();
  expect(document.querySelector('[data-testid=memory-banner]')).toBeNull();
});

test('pressure belongs to its machine and disconnected machines show no stale warning', async () => {
  const first = await machine('first'); const second = await machine('second');
  mounted = mount(MachinesPage, { target: document.body, props: { mobile: true } }); await settle();
  second.client.emitMemory({ threadId: null, kind: 'pressure', state: 'critical', at: 1 });
  first.client.emitMemory({ threadId: null, kind: 'pressure', state: 'ok', at: 1 }); await settle();
  expect(second.store.memoryState).toBe('critical');
  expect(first.store.memoryState).toBe('ok');
  expect(document.querySelector('[data-testid=memory-banner]')).toBeNull();
  second.client.drop(); await settle();
  expect(document.querySelector('[data-testid=memory-banner]')).toBeNull();
});

test('a late snapshot cannot overwrite a newer pressure event, and detach clears the reading', async () => {
  const { client, store } = await machine();
  const snapshot = await client.call('resources.memoryStatus', {});
  let finish!: (value: MemoryStatus) => void;
  const original = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: never) => method === 'resources.memoryStatus'
    ? new Promise<MemoryStatus>(resolve => { finish = resolve; }) : original(method as never, params)) as typeof client.call);
  const reading = store.refreshMemory();
  client.emitMemory({ threadId: null, kind: 'pressure', state: 'critical', at: 1 });
  finish(snapshot); await reading;
  expect(store.memoryState).toBe('critical');
  const detached = store.refreshMemory(); store.detach(); finish(snapshot); await detached;
  expect(store.memory).toBeNull(); expect(store.memoryState).toBeNull();
});
