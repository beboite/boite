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
  const sync = new AutoSettingsSync(() => machines);
  stop = sync.start();
  const [source, target] = machines as [Machine, Machine];
  return { sync, source, target, machines, home: (id: 'source' | 'target' | null) => grouped(machines, id) };
}

/** Both machines in one group, as each core reports it, with `home` as the default machine. */
function grouped(machines: Machine[], home: string | null) {
  const cores = machines.map((machine) => ({ coreId: `core-${machine.id}`, name: machine.id, addresses: [], epoch: 1 }));
  for (const machine of machines) {
    machine.store.group = { id: 'grp', name: 'Home', self: `core-${machine.id}`, cores, devices: [], ...(home === null ? {} : { settingsHome: `core-${home}` }) };
  }
  flushSync();
}

test('a home cleared during module loading or a slow read prevents the pending copy from writing', async () => {
  const { sync, source, target, home } = await fixture();
  await source.store.client!.call('settings.set', { asyncQuestions: false });
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
    home('source');
    await vi.waitFor(() => expect(sync.busy.target).toBe(true));
    home(null);
    releaseModule();
    await vi.waitFor(() => expect(sync.busy.target).toBe(false));
    expect(spy.mock.calls.some(([method]) => method === 'settings.get')).toBe(false);
    vi.doUnmock('./settings-sync');
    slowRead = true;
    home('source');
    await vi.waitFor(() => expect(spy.mock.calls.some(([method]) => method === 'settings.get')).toBe(true));
    home(null);
    release();
    await vi.waitFor(() => expect(sync.busy.target).toBe(false));
    expect(spy.mock.calls.some(([method]) => method === 'settings.set' || method === 'settings.follow')).toBe(false);
    expect((await call('settings.get', {})).asyncQuestions).not.toBe(false);
  } finally { releaseModule(); release(); vi.doUnmock('./settings-sync'); spy.mockRestore(); }
});

test('a failed copy reports its stage and the next change retries, and the home itself copies nothing', async () => {
  const { sync, source, target, home } = await fixture();
  await source.store.client!.call('settings.set', { asyncQuestions: false });
  const client = target.store.client!, call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'settings.set' || method === 'settings.follow'
    ? Promise.reject(new Error('target unavailable')) : call<RpcMethodName>(method, params));
  home('source');
  await vi.waitFor(() => expect(target.store.error).toContain('target unavailable'));
  spy.mockRestore();
  expect(sync.source(source)).toBeUndefined();
  expect(sync.source(target)).toBe(source);
  await source.store.client!.call('settings.set', { muteAgents: false });
  await vi.waitFor(() => expect(target.store.settings?.asyncQuestions).toBe(false));
  expect(target.store.error).toBeNull();
});

test('a setting given back to the home is copied over at once', async () => {
  const { sync, source, target, home } = await fixture();
  await source.store.client!.call('settings.set', { shortAnswers: false });
  home('source');
  await vi.waitFor(() => expect(target.store.settings?.shortAnswers).toBe(false));
  // Changed on the target, it stays there, starred.
  expect(await target.store.saveSettings({ shortAnswers: true })).toBe(true);
  expect(target.store.settings?.syncOverrides).toEqual(['shortAnswers']);
  expect(target.store.kept('shortAnswers')).toBe(true);
  await source.store.client!.call('settings.set', { muteAgents: false });
  await vi.waitFor(() => expect(target.store.settings?.muteAgents).toBe(false));
  expect(target.store.settings?.shortAnswers).toBe(true);
  // Given back: the home's value returns without waiting for its next change.
  expect(await target.store.followHome('shortAnswers')).toBe(true);
  sync.refresh(target);
  await vi.waitFor(() => expect(target.store.settings?.shortAnswers).toBe(false));
  expect(target.store.kept('shortAnswers')).toBe(false);
  // The home's own changes mark nothing there.
  expect(await source.store.saveSettings({ asyncQuestions: false })).toBe(true);
  expect(source.store.settings?.syncOverrides ?? []).toEqual([]);
});

test('two changes on a follower before either save answers both stay kept', async () => {
  const { target, home } = await fixture();
  home('source');
  const client = target.store.client!, call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'settings.set') await gate;
    return call<RpcMethodName>(method, params);
  });
  try {
    const saves = [target.store.saveSettings({ shortAnswers: false }), target.store.saveSettings({ muteAgents: false })];
    release();
    expect(await Promise.all(saves)).toEqual([true, true]);
    expect(target.store.settings?.syncOverrides).toEqual(['shortAnswers', 'muteAgents']);
    expect((await call('settings.get', {})).syncOverrides).toEqual(['shortAnswers', 'muteAgents']);
  } finally { release(); spy.mockRestore(); }
});

test('resetting the keys on a follower keeps what the core named, read or not, and a machine that follows nothing writes nothing for it', async () => {
  const { source, target, home } = await fixture();
  await target.store.client!.call('keybindings.set', { command: 'panel', chord: 'mod+alt+p' });
  // Unrelated to the follow: a machine that follows nothing marks nothing and sends no empty save.
  const sends = vi.spyOn(source.store.client!, 'call');
  await source.store.keep(['keybinding:panel']);
  expect(sends.mock.calls.filter(([method]) => method === 'settings.set' || method === 'settings.get')).toEqual([]);
  sends.mockRestore();
  home('source');
  const named = Object.keys((await target.store.client!.call('keybindings.get', {})).bindings).map((command) => `keybinding:${command}`);
  expect(named).toContain('keybinding:panel');
  target.store.keybindings = null;
  expect(await target.store.resetKeybindings()).toBeNull();
  expect((await target.store.client!.call('settings.get', {})).syncOverrides).toEqual(named);
});

test('a home listed twice copies through the entry that answers', async () => {
  const { sync, source, target, machines, home } = await fixture();
  home('source');
  // The same core under a second address that does not answer, listed first.
  const away = new Store();
  stores.push(away);
  away.group = { ...source.store.group! };
  machines.unshift({ id: 'source-relay', label: 'source', store: away });
  expect(away.connection).not.toBe('ready');
  expect(sync.source(target)).toBe(source);
});
