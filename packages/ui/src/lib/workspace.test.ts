import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from './workspace.svelte';
import { Store, store as primary } from './store.svelte';
import { FakeClient } from './fake-client';
import { upsertEnvironment } from './endpoint';
import * as endpoints from './endpoint';

let workspace: Workspace | undefined;
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  workspace?.close();
  localStorage.clear();
});

test('old local labels become This PC while custom names stay intact', async () => {
  const { w, a } = await setup();
  a.localCore = false;
  a.endpointUrl = 'http://127.0.0.1:41000';
  const machine = { id: a.endpointUrl, label: 'My computer', store: a };
  w.restoreProfile(machine);
  expect(machine.label).toBe('This PC');
  machine.label = 'Studio';
  w.restoreProfile(machine);
  expect(machine.label).toBe('Studio');
});

test('restoring a remote selection also connects the shell local core', async () => {
  const { w, a } = await setup();
  a.localCore = false;
  a.endpointUrl = 'http://remote.test';
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  vi.spyOn(a, 'boot').mockResolvedValue();
  vi.spyOn(endpoints, 'fromTauri').mockResolvedValue({ url: 'http://127.0.0.1:41000', token: 'test', local: true });
  const add = vi.spyOn(w, 'add').mockResolvedValue(true);
  await w.boot();
  expect(add).toHaveBeenCalledWith({ url: 'http://127.0.0.1:41000', token: 'test', local: true }, 'This PC');
});

test('closing while the shell endpoint loads does not add a machine afterward', async () => {
  const { w, a } = await setup();
  a.localCore = false;
  a.endpointUrl = 'http://remote.test';
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  vi.spyOn(a, 'boot').mockResolvedValue();
  let resolveLocal!: (endpoint: endpoints.Endpoint) => void;
  const local = new Promise<endpoints.Endpoint>((resolve) => { resolveLocal = resolve; });
  const fromTauri = vi.spyOn(endpoints, 'fromTauri').mockReturnValue(local);
  const add = vi.spyOn(w, 'add');
  const boot = w.boot();
  await waitFor(() => fromTauri.mock.calls.length === 1);
  w.close();
  resolveLocal({ url: 'http://127.0.0.1:41000', token: 'test', local: true });
  await boot;
  expect(add).not.toHaveBeenCalled();
  expect(w.machines).toEqual([]);
});

test('an old endpoint connection cannot update a newer workspace lifecycle', async () => {
  const { w } = await setup();
  let release!: () => void;
  const connected = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(Store.prototype, 'connectEndpoint').mockImplementation(async function (this: Store) {
    await connected;
    this.connection = 'ready';
  });
  const endpoint = { url: 'http://late.test', token: 'test', paired: true };
  const adding = w.add(endpoint, 'Old name');
  await waitFor(() => w.machines.some((machine) => machine.id === endpoint.url));
  const late = w.machines.find((machine) => machine.id === endpoint.url)!;
  w.close();
  const current = { ...late, label: 'New name' };
  w.machines = [current];
  release();
  expect(await adding).toBe(false);
  expect(w.machines[0]?.label).toBe('New name');
  expect(endpoints.readEnvironments().some((saved) => saved.url === endpoint.url)).toBe(false);
});

test('a pairing link replaces the key of a machine that never stopped connecting', async () => {
  const { w, a } = await setup();
  const url = 'https://core.test';
  a.endpointUrl = url;
  w.machines = [{ id: url, label: 'This PC', store: a }];
  const connect = vi.spyOn(Store.prototype, 'connectEndpoint').mockImplementation(async function (this: Store) {
    this.connection = 'ready';
  });
  // Answering: the link is refused and the working connection is left alone.
  expect(await w.pair(`${url}/?grant=g1`, '')).toBe(false);
  expect(w.error).toBe('This machine is already connected.');
  expect(connect).not.toHaveBeenCalled();
  // Retrying a refused key forever, as a phone whose session is gone does.
  a.connection = 'connecting';
  expect(await w.pair(`${url}/?grant=g2`, '')).toBe(true);
  expect(connect).toHaveBeenCalledWith({ url, grant: 'g2', token: '' });
  expect(w.error).toBeNull();
  expect(w.machines).toHaveLength(1);
});

test('a second machine never takes a name already listed, and a link says which machine it reaches', async () => {
  const { w } = await setup();
  vi.spyOn(Store.prototype, 'connectEndpoint').mockImplementation(async function (this: Store) {
    this.connection = 'ready';
  });
  // Typed after a machine already listed: the address tells them apart.
  expect(await w.pair('https://other.test/?grant=g1', 'Local')).toBe(true);
  expect(w.machines.map((machine) => machine.label)).toEqual(['Local', 'Remote', 'Local (other.test)']);
  expect(endpoints.readEnvironments().find((saved) => saved.url === 'https://other.test')).toBeUndefined();
  // Renamed onto another machine's name: same rule, and the first holder keeps its own.
  w.customize('remote', 'local');
  expect(w.machines.map((machine) => machine.label)).toEqual(['Local', 'local (remote)', 'Local (other.test)']);
  expect(w.linkTarget('https://other.test/?grant=g2')).toMatchObject({ host: 'other.test', machine: { label: 'Local (other.test)' } });
  expect(w.linkTarget('https://new.test:8443/?grant=g3')).toEqual({ host: 'new.test:8443', machine: null });
  expect(w.linkTarget('not a link')).toBeNull();
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('workspace did not reach the expected state');
}

test('an empty local core yields to the remembered journal on the same computer', async () => {
  const { w, a, b } = await setup();
  a.localCore = true;
  a.threads = [];
  a.core = { ...a.core!, hostname: 'desktop', dataDir: '/fresh-dev' };
  b.core = { ...b.core!, hostname: 'desktop', dataDir: '/existing' };
  a.endpointUrl = 'http://local.test';
  upsertEnvironment({ url: 'http://saved.test', token: 'fake', paired: true, label: 'Studio' });
  const boot = vi.spyOn(a, 'boot').mockResolvedValue();
  vi.spyOn(w, 'add').mockImplementation(async () => {
    w.machines = [...w.machines, {id: 'http://saved.test', label: 'Studio', store: b}];
    return true;
  });
  const restore = vi.spyOn(a, 'switchEnvironment').mockImplementation(async () => {
    a.core = b.core;
    a.threads = b.threads;
    a.localCore = false;
  });
  await w.boot();
  expect(boot).toHaveBeenCalledWith();
  expect(restore).toHaveBeenCalledWith('http://saved.test');
  expect(w.machines).toHaveLength(1);
  expect(w.machines[0]?.label).toBe('Studio');
  expect(a.threads.length).toBeGreaterThan(0);
});
test('a notification link reaches the page core before a remembered machine answers', async () => {
  const { w, a } = await setup();
  a.endpointUrl = window.location.origin;
  upsertEnvironment({ url: 'http://offline.test', token: 'fake', paired: true, label: 'Offline' });
  const boot = vi.spyOn(a, 'boot').mockResolvedValue();
  // A remote that never answers, as an offline LAN host hangs.
  vi.spyOn(w, 'add').mockReturnValue(new Promise<boolean>(() => {}));
  void w.boot('t-scheduler');
  await waitFor(() => boot.mock.calls.length === 1);
  expect(boot).toHaveBeenCalledWith(false, 't-scheduler');
});

test('a notification link from another remembered machine opens there once it connects', async () => {
  const { w, a, b } = await setup();
  a.endpointUrl = 'http://remote.test';
  b.endpointUrl = window.location.origin;
  const id = b.threads[0]!.id;
  upsertEnvironment({ url: window.location.origin, token: 'fake', paired: true, label: 'Page' });
  vi.spyOn(a, 'boot').mockResolvedValue();
  vi.spyOn(w, 'add').mockImplementation(async () => {
    w.machines = [...w.machines, { id: window.location.origin, label: 'Page', store: b }];
    return true;
  });
  await w.boot(id);
  expect(w.active).toBe(b);
  expect(b.openThread?.id).toBe(id);
});

async function setup() {
  workspace = new Workspace();
  const a = primary,
    b = new Store();
  a.openThread = null;
  a.draft = null;
  a.visible = true;
  const ca = new FakeClient({ delayMs: 0 }),
    cb = new FakeClient({ delayMs: 0 });
  a.attach(ca);
  b.attach(cb);
  b.machineId = 'remote';
  b.visible = false;
  await Promise.all([a.connect(), b.connect()]);
  workspace.machines = [
    { id: 'local', label: 'Local', store: a },
    { id: 'remote', label: 'Remote', store: b }
  ];
  workspace.active = a;
  return { w: workspace, a, b, ca, cb };
}

test('identical ids on two hosts route rename, pin, permission and notifications to their owner', async () => {
  const { w, a, b } = await setup();
  const id = a.threads[0]!.id;
  expect(b.threads.some((t) => t.id === id)).toBe(true);
  await w.select(b, id);
  await b.rename(id, 'Remote only');
  await b.pin(id, true);
  expect(b.openThread?.title).toBe('Remote only');
  expect(a.threads.find((t) => t.id === id)?.title).not.toBe('Remote only');
  expect(a.threads.find((t) => t.id === id)?.pinned).toBe(false);
  const permission = b.pendingPermissions[0]!;
  expect(a.pendingPermissions.some((p) => p.id === permission.id)).toBe(true);
  await b.answer(permission.id, 'allow');
  expect(b.pendingPermissions.some((p) => p.id === permission.id)).toBe(false);
  expect(a.pendingPermissions.some((p) => p.id === permission.id)).toBe(true);
  await w.select(a, id);
  await w.openNotification(b.threadKey(id));
  expect(w.active).toBe(b);
  expect(w.active.openThread?.title).toBe('Remote only');
  expect(a.threadKey(id)).not.toBe(b.threadKey(id));
});

test('only the visible host keeps a thread subscription, and switching back resumes it', async () => {
  const { w, a, b, ca, cb } = await setup();
  const left = vi.spyOn(ca, 'call'),
    right = vi.spyOn(cb, 'call');
  const id = a.threads[0]!.id;
  await w.select(a, id);
  await w.select(b, id);
  expect(left).toHaveBeenCalledWith('threads.unsubscribe', { threadId: id });
  expect(a.visible).toBe(false);
  await w.select(a);
  expect(right).toHaveBeenCalledWith('threads.unsubscribe', { threadId: id });
  expect(a.visible).toBe(true);
  expect(left.mock.calls.filter(([m]) => m === 'threads.subscribe')).toHaveLength(2);
});

test('disconnecting the active remote keeps primary data and the view preference', async () => {
  const { w, a, b } = await setup();
  await w.select(b, b.threads[0]!.id);
  w.setView('recent');
  await w.remove('remote');
  expect(w.active).toBe(a);
  expect(a.connection).toBe('ready');
  expect(w.machines).toHaveLength(1);
  expect(localStorage.getItem('boite.thread-view')).toBe('recent');
  expect(b.client).toBeNull();
});

test('machine names and icons persist independently and survive an endpoint change', async () => {
  const { w, a, b } = await setup();
  a.core = { ...a.core!, hostname: 'desktop', dataDir: '/local' };
  b.core = { ...b.core!, hostname: 'server', dataDir: '/remote' };
  w.customize('local', 'Studio', 'desktop');
  w.customize('remote', 'Build server', 'rack');
  const restored = { id: 'new-address', label: 'server', store: b };
  w.restoreProfile(restored);
  expect(restored).toMatchObject({ label: 'Build server', icon: 'rack' });
  expect(w.machines[0]).toMatchObject({ label: 'Studio', icon: 'desktop' });
  w.customize('local', '  ', 'cloud');
  expect(w.machines[0]?.label).toBe('Studio');
});


test('agent links resolve core identity despite identical thread ids and open both directions', async () => {
  const { w, a, b } = await setup();
  const id = a.threads[0]!.id;
  const local = { coreId: (await a.coordinationIdentity()).coreId, threadId: id };
  const remote = { coreId: (await b.coordinationIdentity()).coreId, threadId: id };
  await b.rename(id, 'Remote sender');
  await w.select(a, id);
  await w.openAgentThread(a, local, remote);
  expect(w.active).toBe(b);
  expect(b.openThread?.title).toBe('Remote sender');
  await w.openAgentThread(b, remote, local);
  expect(w.active).toBe(a);
  expect(a.openThread?.title).not.toBe('Remote sender');
  await w.openAgentThread(a, { coreId: 'local', threadId: id }, { coreId: 'local', threadId: a.threads[1]!.id });
  expect(w.active).toBe(a);
  expect(a.openThread?.id).toBe(a.threads[1]!.id);
});

test('an unconnected core never opens a coincident local thread id', async () => {
  const { w, a } = await setup();
  const id = a.threads[0]!.id;
  await w.select(a, id);
  const open = vi.spyOn(a, 'open');
  await w.openAgentThread(a, { coreId: (await a.coordinationIdentity()).coreId, threadId: id }, { coreId: 'not-connected', threadId: id });
  expect(open).not.toHaveBeenCalled();
  expect(w.active).toBe(a);
  expect(a.error).toBe('Connect to this machine in Settings to open its thread.');
});


test('a paired phone can follow an agent link without owner-only identity RPC access', async () => {
  const { w, a, b } = await setup();
  const id = a.threads[0]!.id;
  b.client?.close();
  b.detach();
  const device = new FakeClient({ delayMs: 0, principal: 'session', coreId: 'remote-phone' });
  b.attach(device);
  await b.connect();
  await expect(b.coordinationIdentity()).rejects.toThrow('owner');
  await w.select(a, id);
  await w.openAgentThread(a, { coreId: (await a.coordinationIdentity()).coreId, threadId: id }, { coreId: 'remote-phone', threadId: id });
  expect(w.active).toBe(b);
  expect(b.openThread?.id).toBe(id);
  expect(b.owner).toBe(false);
});
