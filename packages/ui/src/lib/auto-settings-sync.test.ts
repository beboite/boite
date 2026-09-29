import { afterEach, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { RpcMethodName } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { AutoSettingsSync } from './auto-settings-sync.svelte';
import type { Machine } from './workspace.svelte';

let stop: (() => void) | undefined;
const stores: Store[] = [];
afterEach(() => {
  stop?.(); stop = undefined;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  localStorage.clear();
});
async function fixture() {
  const machines: Machine[] = [];
  for (const id of ['source', 'target']) {
    const store = new Store();
    store.attach(new FakeClient({ delayMs: 0 }));
    await store.connect();
    stores.push(store);
    machines.push({ id, label: id, store });
  }
  const sync = new AutoSettingsSync(() => machines, machine => machine.id);
  stop = sync.start();
  const [source, target] = machines as [Machine, Machine];
  return { sync, source, target };
}

test('unchecking during module loading or a slow read prevents the pending copy from writing', async () => {
  const { sync, source, target } = await fixture();
  await source.store.client!.call('settings.set', { warmProcessMinutes: 9 });
  const client = target.store.client!, call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let releaseModule!: () => void;
  const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
  vi.doMock('./settings-sync', async () => {
    await moduleGate;
    return vi.importActual('./settings-sync');
  });
  let slowRead = false;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call<RpcMethodName>(method, params);
    if (method === 'settings.get' && slowRead) await gate;
    return result;
  });
  try {
    sync.set(target, source);
    flushSync();
    await vi.waitFor(() => expect(sync.busy.target).toBe(true));
    sync.set(target, null);
    flushSync();
    releaseModule();
    await vi.waitFor(() => expect(sync.busy.target).toBe(false));
    expect(spy.mock.calls.some(([method]) => method === 'settings.get')).toBe(false);
    vi.doUnmock('./settings-sync');
    slowRead = true;
    sync.set(target, source);
    flushSync();
    await vi.waitFor(() => expect(spy.mock.calls.some(([method]) => method === 'settings.get')).toBe(true));
    sync.set(target, null);
    flushSync();
    release();
    await vi.waitFor(() => expect(sync.busy.target).toBe(false));
    expect(spy.mock.calls.some(([method]) => method === 'settings.set')).toBe(false);
    expect((await call('settings.get', {})).warmProcessMinutes).not.toBe(9);
  } finally { releaseModule(); release(); vi.doUnmock('./settings-sync'); spy.mockRestore(); }
});

test('a failed copy reports its stage and the next change retries, while reverse links are refused', async () => {
  const { sync, source, target } = await fixture();
  await source.store.client!.call('settings.set', { warmProcessMinutes: 9 });
  const client = target.store.client!, call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'settings.set'
    ? Promise.reject(new Error('target unavailable')) : call<RpcMethodName>(method, params));
  sync.set(target, source);
  flushSync();
  await vi.waitFor(() => expect(target.store.error).toContain('target unavailable'));
  spy.mockRestore();
  sync.set(source, target);
  expect(sync.enabled(source)).toBe(false);
  await source.store.client!.call('settings.set', { warmProcessMinutes: 12 });
  await vi.waitFor(() => expect(target.store.settings?.warmProcessMinutes).toBe(12));
  expect(target.store.error).toBeNull();
});
