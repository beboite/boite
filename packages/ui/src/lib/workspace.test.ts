import { afterEach, expect, test, vi } from 'vitest';
import { machineHealth, Workspace } from './workspace.svelte';
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
test('a machine the group brought never becomes the page core by claiming this computer\'s name, and its key over plain HTTP waits to be vetted', async () => {
  const { w, a, b } = await setup();
  a.localCore = true;
  a.threads = [];
  a.core = { ...a.core!, hostname: 'desktop', dataDir: '/fresh-dev' };
  b.core = { ...b.core!, hostname: 'desktop', dataDir: '/elsewhere' };
  a.endpointUrl = 'http://local.test';
  upsertEnvironment({ url: 'http://local.test', token: 'fake', paired: true, label: 'Local', coreId: 'a', groupId: 'grp' });
  upsertEnvironment({ url: 'http://10.0.0.7:1', token: 'fake', paired: true, label: 'Studio', coreId: 'b', groupId: 'grp' });
  upsertEnvironment({ url: 'http://10.0.0.8:1', token: 'fake', paired: true, label: 'Retired', coreId: 'c', groupId: 'grp' });
  const vet = vi.spyOn(w.groups, 'vet').mockImplementation(async (held) => held.filter((env) => env.coreId !== 'c'));
  // The page opened on a pairing link for its own machine: the exchange takes the group's mark off the saved entry.
  vi.spyOn(a, 'boot').mockImplementation(async () => { endpoints.rememberSession({ url: 'http://local.test', token: '', grant: 'g' }, 'by-hand'); });
  const add = vi.spyOn(w, 'add').mockImplementation(async (endpoint) => {
    w.machines = [...w.machines, { id: endpoint.url, label: 'Studio', store: b, coreId: 'b', groupId: 'grp' }];
    return true;
  });
  const restore = vi.spyOn(a, 'switchEnvironment').mockResolvedValue();
  await w.boot();
  expect(vet.mock.calls[0]![0].map((env) => env.coreId)).toEqual(['a', 'b', 'c']);
  // The key that was refused is never sent; the one that stands is.
  expect(add.mock.calls.map(([endpoint]) => endpoint.url)).toEqual(['http://10.0.0.7:1']);
  expect(restore).not.toHaveBeenCalled();
  expect(w.machines.map((machine) => [machine.id, machine.coreId])).toEqual([['http://local.test', undefined], ['http://10.0.0.7:1', 'b']]);
});

test('the window opens on a machine paired by hand when the key of the one it would open on is refused at start', async () => {
  const { w, a } = await setup();
  endpoints.storeEndpoint({ url: 'http://10.0.0.8:1', token: 'old', paired: true });
  upsertEnvironment({ url: 'http://10.0.0.8:1', token: 'old', paired: true, label: 'Retired', coreId: 'c', groupId: 'grp' });
  upsertEnvironment({ url: 'https://anchor.test', token: 'hand', paired: true, label: 'Anchor' });
  const vet = vi.spyOn(w.groups, 'vet').mockImplementation(async (held, anchors) => {
    expect(anchors).toEqual([{ url: 'https://anchor.test', token: 'hand', paired: true }]);
    for (const env of held) endpoints.removeEnvironment(env.url);
    return [];
  });
  // By the time the page core connects, the refused key is no longer the one it would send.
  const boot = vi.spyOn(a, 'boot').mockImplementation(async () => {
    expect(endpoints.readStoredEndpoint()).toMatchObject({ url: 'https://anchor.test', token: 'hand' });
  });
  vi.spyOn(w, 'add').mockResolvedValue(true);
  await w.boot();
  expect(vet).toHaveBeenCalledTimes(1);
  expect(boot).toHaveBeenCalledTimes(1);
});

test('a refused key is sent nowhere: not through a link that reopens its core, not read back once it was the last entry', async () => {
  const { w, a } = await setup();
  // The answer takes a moment, as a question over the network does: nothing may be sent meanwhile.
  const refuse = () => vi.spyOn(w.groups, 'vet').mockImplementation(async (held) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const env of held) endpoints.removeEnvironment(env.url);
    return [];
  });
  vi.spyOn(w, 'add').mockResolvedValue(true);
  // A page sends the owner to `?core=` of a machine the group brought: the link waits for the answer like the stored core does.
  endpoints.storeEndpoint({ url: 'https://anchor.test', token: 'hand', paired: true });
  upsertEnvironment({ url: 'https://anchor.test', token: 'hand', paired: true, label: 'Anchor' });
  upsertEnvironment({ url: 'http://10.0.0.8:1', token: 'old', paired: true, label: 'Retired', coreId: 'c', groupId: 'grp' });
  window.history.replaceState(null, '', '/?core=http%3A%2F%2F10.0.0.8%3A1');
  let vet = refuse();
  const boot = vi.spyOn(a, 'boot').mockImplementation(async () => {
    expect(endpoints.readEnvironments().map((env) => env.url)).toEqual(['https://anchor.test']);
  });
  await w.boot();
  expect(vet).toHaveBeenCalledTimes(1);
  expect(boot).toHaveBeenCalledTimes(1);
  window.history.replaceState(null, '', '/');

  // In the shell, the only saved machine is one the group brought and the window was left on it.
  localStorage.clear();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  vi.spyOn(endpoints, 'fromTauri').mockResolvedValue({ url: 'http://127.0.0.1:41000', token: 'test', local: true });
  endpoints.storeEndpoint({ url: 'http://10.0.0.8:1', token: 'old', paired: true });
  upsertEnvironment({ url: 'http://10.0.0.8:1', token: 'old', paired: true, label: 'Retired', coreId: 'c', groupId: 'grp' });
  vet.mockRestore();
  vet = refuse();
  boot.mockImplementation(async () => {
    // Its key is gone from both places, and the emptied list did not seed it back as a machine paired by hand.
    expect(endpoints.readStoredEndpoint()).toBeNull();
    expect(endpoints.readEnvironments()).toEqual([]);
  });
  await w.boot();
  expect(vet.mock.calls[0]![1]).toEqual([{ url: 'http://127.0.0.1:41000', token: 'test', local: true }]);
  expect(boot).toHaveBeenCalledTimes(2);

  // A link to a core nobody knows, which the owner may decline: the stored core it would fall back on is asked about all the same.
  delete window.__TAURI_INTERNALS__;
  localStorage.clear();
  endpoints.storeEndpoint({ url: 'http://10.0.0.8:1', token: 'old', paired: true });
  upsertEnvironment({ url: 'http://10.0.0.8:1', token: 'old', paired: true, label: 'Retired', coreId: 'c', groupId: 'grp' });
  upsertEnvironment({ url: 'https://anchor.test', token: 'hand', paired: true, label: 'Anchor' });
  window.history.replaceState(null, '', '/?core=https%3A%2F%2Funknown.example');
  vet.mockRestore();
  vet = refuse();
  boot.mockImplementation(async () => {
    expect(endpoints.readStoredEndpoint()).toMatchObject({ url: 'https://anchor.test', token: 'hand' });
  });
  await w.boot();
  window.history.replaceState(null, '', '/');
  expect(vet).toHaveBeenCalledTimes(1);
  expect(boot).toHaveBeenCalledTimes(3);
});

test('a machine the group brought stays the group\'s to drop when its key is refused as the window opens on it', async () => {
  const { w, a } = await setup();
  a.localCore = false;
  a.endpointUrl = 'https://b.example';
  upsertEnvironment({ url: 'https://b.example', token: 'old', paired: true, label: 'B', coreId: 'b', groupId: 'grp' });
  // The hello is refused: the dead key and its saved entry go during the boot.
  vi.spyOn(a, 'boot').mockImplementation(async () => { endpoints.removeEnvironment('https://b.example', 'old'); });
  vi.spyOn(w, 'add').mockResolvedValue(true);
  await w.boot();
  expect(w.machines[0]).toMatchObject({ id: 'https://b.example', coreId: 'b', groupId: 'grp' });

  // The entry goes during the boot and the window connects all the same, on a key a link brought:
  // written again, the entry is still one the group brought.
  upsertEnvironment({ url: 'https://b.example', token: 'old', paired: true, label: 'B', coreId: 'b', groupId: 'grp' });
  vi.spyOn(a, 'boot').mockImplementation(async () => {
    endpoints.removeEnvironment('https://b.example', 'old');
    endpoints.storeEndpoint({ url: 'https://b.example', token: 'from-a-link', paired: true });
  });
  await w.boot();
  expect(endpoints.readEnvironments().find((env) => env.url === 'https://b.example')).toMatchObject({ token: 'from-a-link', coreId: 'b', groupId: 'grp' });
  expect(w.machines[0]).toMatchObject({ coreId: 'b', groupId: 'grp' });

  // A pairing link the owner said yes to, opened during the boot: the entry it wrote is the owner's, and stays so.
  vi.spyOn(a, 'boot').mockImplementation(async () => {
    endpoints.rememberSession({ url: 'https://b.example', token: '', grant: 'g' }, 'by-hand');
    endpoints.storeEndpoint({ url: 'https://b.example', token: 'by-hand', paired: true });
  });
  await w.boot();
  const entry = endpoints.readEnvironments().find((env) => env.url === 'https://b.example')!;
  expect([entry.token, entry.coreId, w.machines[0]!.coreId]).toEqual(['by-hand', undefined, undefined]);
});

test('a stored core the group brought is still one when the list has no entry left for it', async () => {
  const { w, a } = await setup();
  a.localCore = false;
  a.endpointUrl = 'http://10.0.0.8:1';
  // Another window dropped the saved entry; this key, from an earlier ticket, stayed as the core the window opens on.
  endpoints.storeEndpoint({ url: 'http://10.0.0.8:1', token: 'earlier', paired: true, coreId: 'c', groupId: 'grp' });
  upsertEnvironment({ url: 'https://anchor.test', token: 'hand', paired: true, label: 'Anchor' });
  const vet = vi.spyOn(w.groups, 'vet').mockImplementation(async (held) => held);
  vi.spyOn(a, 'boot').mockResolvedValue();
  vi.spyOn(w, 'add').mockResolvedValue(true);
  await w.boot();
  // Asked about before its key is sent, and listed as the group's, so the group can drop it.
  expect(vet.mock.calls[0]![0].map((env) => [env.url, env.coreId])).toEqual([['http://10.0.0.8:1', 'c']]);
  expect(w.machines[0]).toMatchObject({ id: 'http://10.0.0.8:1', coreId: 'c', groupId: 'grp' });
  expect(endpoints.readEnvironments().find((env) => env.url === 'http://10.0.0.8:1')).toMatchObject({ coreId: 'c', groupId: 'grp' });
});

test('a window whose machine the group dropped falls back on a machine paired by hand, never on the address it dropped', async () => {
  const { w, a } = await setup();
  a.endpointUrl = 'http://10.0.0.8:1';
  w.machines = [{ id: 'http://10.0.0.8:1', label: 'Retired', store: a, coreId: 'c', groupId: 'grp' }];
  upsertEnvironment({ url: 'http://10.0.0.8:1', token: 'old', paired: true, label: 'Retired', coreId: 'c', groupId: 'grp' });
  upsertEnvironment({ url: 'https://anchor.test', token: 'hand', paired: true, label: 'Anchor' });
  const order: string[] = [];
  vi.spyOn(a, 'switchEnvironment').mockImplementation(async (url) => { order.push(`switch ${url}`); a.endpointUrl = url; });
  vi.spyOn(a, 'forgetEnvironment').mockImplementation(async (url) => { order.push(`forget ${url}`); endpoints.removeEnvironment(url); });
  await w.dropPrimary('http://10.0.0.8:1');
  expect(order).toEqual(['switch https://anchor.test', 'forget http://10.0.0.8:1']);
  expect(w.machines.map((machine) => [machine.id, machine.coreId])).toEqual([['https://anchor.test', undefined]]);
});

test('a window served by the machine the group dropped stays closed rather than reach it again with no key', async () => {
  const { w, a, b } = await setup();
  const origin = window.location.origin;
  a.endpointUrl = origin;
  w.machines = [{ id: origin, label: 'Dropped', store: a, coreId: 'c', groupId: 'grp' }, { id: 'https://anchor.test', label: 'Anchor', store: b }];
  // Its saved entry is the only one: the pairing of the other machine was forgotten in another window.
  upsertEnvironment({ url: origin, token: 'old', paired: true, label: 'Dropped', coreId: 'c', groupId: 'grp' });
  const select = vi.spyOn(w, 'select').mockResolvedValue();
  await w.dropPrimary(origin);
  expect(a.connection).toBe('closed');
  expect(a.client).toBeNull();
  expect(endpoints.readEnvironments()).toEqual([]);
  // The window shows the machine paired by hand that is still connected.
  expect(select).toHaveBeenCalledWith(b);
});

test('a machine the group drops goes from this window, and its saved entry only while it is still the group\'s', async () => {
  const { w, b } = await setup();
  const url = 'http://10.0.0.7:1';
  w.machines = [...w.machines.filter((machine) => machine.store !== b), { id: url, label: 'Studio', store: b, coreId: 'b', groupId: 'grp' }];
  // Another window paired it by hand meanwhile: the entry is the owner's, with a key of its own.
  upsertEnvironment({ url, token: 'by-hand', paired: true, label: 'Studio' });
  await w.remove(url);
  expect(w.machines.some((machine) => machine.id === url)).toBe(false);
  expect(endpoints.readEnvironments().find((env) => env.url === url)).toMatchObject({ token: 'by-hand' });
  // Still the entry the group brought: it goes.
  upsertEnvironment({ url: 'http://10.0.0.8:1', token: 'from-group', paired: true, label: 'Other', coreId: 'c', groupId: 'grp' });
  w.machines = [...w.machines, { id: 'http://10.0.0.8:1', label: 'Other', store: new Store(), coreId: 'c', groupId: 'grp' }];
  await w.remove('http://10.0.0.8:1');
  expect(endpoints.readEnvironments().some((env) => env.url === 'http://10.0.0.8:1')).toBe(false);
});

test('a machine the group brought is written back as one when its entry went while it connected', async () => {
  const { w } = await setup();
  vi.spyOn(Store.prototype, 'connectEndpoint').mockImplementation(async function (this: Store) {
    // Another window dropped the entry while this one was saying hello.
    endpoints.removeEnvironment('http://10.0.0.7:1');
    this.connection = 'ready';
  });
  upsertEnvironment({ url: 'http://10.0.0.7:1', token: 'from-group', paired: true, label: 'Studio', coreId: 'b', groupId: 'grp' });
  expect(await w.add({ url: 'http://10.0.0.7:1', token: 'from-group', paired: true, coreId: 'b', groupId: 'grp' }, 'Studio', true)).toBe(true);
  expect(endpoints.readEnvironments().find((env) => env.url === 'http://10.0.0.7:1')).toMatchObject({ coreId: 'b', groupId: 'grp' });
});

test('a key refused late does not take away the pairing another window made meanwhile', () => {
  const url = 'http://10.0.0.5:9000';
  upsertEnvironment({ url, token: 'new-by-hand', paired: true });
  expect(endpoints.removeEnvironment(url, 'old-from-group')).toHaveLength(1);
  expect(endpoints.removeEnvironment(url, 'new-by-hand')).toEqual([]);
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

test('a remote machine switched off is offline, and lost only while the user depends on it', async () => {
  const { a, b } = await setup();
  const remote = { id: 'http://laptop.test', label: 'Laptop', store: b };
  b.localCore = false;
  b.endpointUrl = remote.id;
  b.booted = true;
  b.connection = 'closed';
  b.threads = b.threads.map(t => ({ ...t, status: 'idle' as const }));
  expect(machineHealth(remote, a)).toBe('offline');
  // A key the machine refused needs the user to pair again.
  const refused = vi.spyOn(b, 'pairingRequired', 'get').mockReturnValue(true);
  expect(machineHealth(remote, a)).toBe('lost');
  refused.mockRestore();
  // A turn that was running when it went away is work cut off, which is worth a warning.
  b.threads = [{ ...b.threads[0]!, status: 'running' }, ...b.threads.slice(1)];
  expect(machineHealth(remote, a)).toBe('lost');
  // The machine this window runs on is always needed.
  a.booted = true;
  a.connection = 'closed';
  expect(machineHealth({ id: 'local', label: 'Local', store: a }, a)).toBe('lost');
  a.connection = 'ready';
  expect(machineHealth({ id: 'local', label: 'Local', store: a }, a)).toBe('ready');
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
  expect(ca.coreSubscribers).toEqual([id]);
  expect(cb.coreSubscribers).toEqual([]);
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

test.each(['draft', 'thread'] as const)('a delayed agent link cannot replace a later %s opened directly on the Store', async (next) => {
  const { w, a, b } = await setup();
  await w.select(a, 't-trace');
  const self = { coreId: (await a.coordinationIdentity()).coreId, threadId: 't-trace' };
  const remote = { coreId: (await b.coordinationIdentity()).coreId, threadId: 't-descriptors' };
  const call = b.client!.call.bind(b.client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(b.client!, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'collaboration.get') await gate;
    return result;
  });
  const opening = w.openAgentThread(a, self, remote);
  try {
    if (next === 'draft') a.startDraft('p-boite');
    else await a.open('t-scheduler');
    release();
    await opening;
    expect(w.active).toBe(a);
    expect(a.openThread?.id ?? null).toBe(next === 'draft' ? null : 't-scheduler');
    expect(a.draft?.projectId ?? null).toBe(next === 'draft' ? 'p-boite' : null);
  } finally { release(); await opening; }
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
