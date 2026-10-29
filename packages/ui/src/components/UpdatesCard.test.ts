import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode, type ServerUpdateStatus } from '@boite/contracts';
import UpdatesCard from './UpdatesCard.svelte';
import MachinesPage from './MachinesPage.svelte';
import { AppUpdater, type AppUpdateBackend, type UpdateSnapshot } from '../lib/app-update.svelte';
import { FakeClient } from '../lib/fake-client';
import { RpcFailure } from '../lib/client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { confirm } from '../lib/confirm.svelte';
import { strings } from '../lib/strings';

let view: ReturnType<typeof mount> | undefined;
const stores: Store[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  for (const stop of stops.splice(0)) stop();
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  workspace.machines = [];
  workspace.active = primary;
  confirm.answer(false);
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});
const one = <T extends HTMLElement>(testid: string) => document.querySelector<T>(`[data-testid="${testid}"]`);

/** The desktop app's updater, answering `snapshot` and letting the test publish what the shell says next. */
async function app(snapshot: UpdateSnapshot, extra: Partial<AppUpdateBackend> = {}) {
  let publish!: (next: UpdateSnapshot) => void;
  const native: AppUpdateBackend = {
    status: vi.fn(async () => snapshot),
    check: vi.fn(async () => snapshot),
    download: vi.fn(async () => snapshot),
    install: vi.fn(async () => undefined),
    listen: vi.fn(async (handler) => { publish = handler; return () => undefined; }),
    ...extra
  };
  const updater = new AppUpdater(native, undefined, () => true);
  stops.push(updater.start());
  await updater.settled();
  return { updater, native, publish: (next: UpdateSnapshot) => { publish(next); flushSync(); } };
}
const nightly = (phase: UpdateSnapshot['phase'], version: string | null = null): UpdateSnapshot => ({
  phase, currentVersion: '2.0.0-nightly.20261022.1', currentChannel: 'nightly', channel: 'nightly', version,
  notes: null, publishedAt: null, received: 0, total: null, error: null, supported: true
});

async function machine(id: string, offered: boolean) {
  history.replaceState(null, '', offered ? '/?fake=1&serverUpdate=available' : '/?fake=1');
  const store = new Store(); stores.push(store);
  store.machineId = id;
  const client = new FakeClient({ delayMs: 0, coreId: id, coreName: id });
  store.attach(client); await store.connect();
  await store.serverUpdater.load();
  workspace.machines = [...workspace.machines, { id, label: id, store }];
  workspace.active = workspace.machines[0]!.store;
  return { store, client };
}

test('nothing folded: the version, the release found, the channel with Release closed, one check and one update', async () => {
  const { updater, native } = await app(nightly('available', '2.0.0-nightly.20261022.2'));
  view = mount(UpdatesCard, { target: document.body, props: { updater, native: true } });
  flushSync();
  expect(document.querySelector('details, [aria-expanded]')).toBeNull();
  expect(one('updates-version')!.textContent).toContain('2.0.0-nightly.20261022.1');
  expect(one('updates-found')!.textContent).toBe('2.0.0-nightly.20261022.2');
  expect(one<HTMLAnchorElement>('app-update-changelog')!.href).toBe('https://github.com/mtsu-dev/boite/releases/tag/v2.0.0-nightly.20261022.2');
  expect(one('app-update-status')!.textContent).toContain(strings.harnessUpdates.availableShort);
  const [nightlyButton, release] = [one<HTMLButtonElement>('app-update-nightly')!, one<HTMLButtonElement>('app-update-stable')!];
  expect([nightlyButton.getAttribute('aria-pressed'), nightlyButton.disabled]).toEqual(['true', false]);
  // No stable release exists yet: Release stays visible, closed, and says why.
  expect([release.disabled, release.title]).toEqual([true, strings.appUpdate.noRelease]);
  expect(one<HTMLButtonElement>('updates-run-all')!.disabled).toBe(false);
  one<HTMLButtonElement>('updates-check-all')!.click();
  await vi.waitFor(() => expect(native.check).toHaveBeenCalledWith('nightly'));
});

test('a downloaded release restarts on a confirmed click, and waiting offers a cancel that locks the channel', async () => {
  let finishCancel!: (accepted: boolean) => void;
  const { updater, native, publish } = await app(nightly('ready', '2.0.0-nightly.20261022.2'), {
    cancelInstall: vi.fn(() => new Promise<boolean>((resolve) => { finishCancel = resolve; }))
  });
  view = mount(UpdatesCard, { target: document.body, props: { updater, native: true } });
  flushSync();
  const run = one<HTMLButtonElement>('updates-run-all')!;
  expect(run.textContent).toContain(strings.updateAll.restart);
  run.click();
  await vi.waitFor(() => expect(confirm.current?.title).toBe(strings.appUpdate.installTitle));
  confirm.answer(true);
  await vi.waitFor(() => expect(native.install).toHaveBeenCalledOnce());
  publish(nightly('waiting', '2.0.0-nightly.20261022.2'));
  expect(one('updates-run-all')).toBeNull();
  expect(one<HTMLButtonElement>('app-update-nightly')!.disabled).toBe(true);
  one<HTMLButtonElement>('app-update-cancel')!.click();
  flushSync();
  expect(one<HTMLButtonElement>('app-update-cancel')!.disabled).toBe(true);
  finishCancel(true);
  publish(nightly('ready', '2.0.0-nightly.20261022.2'));
  expect(one('app-update-cancel')).toBeNull();
  expect(one<HTMLButtonElement>('app-update-nightly')!.disabled).toBe(false);
});

test("another machine's update is listed under the app's, starts with the same button, and can be cancelled while it waits", async () => {
  const { updater } = await app(nightly('current'));
  const server = await machine('builder', true);
  const other = await machine('other', false);
  const call = vi.spyOn(server.client, 'call');
  const otherCall = vi.spyOn(other.client, 'call');
  view = mount(UpdatesCard, { target: document.body, props: { updater, native: true } });
  await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('[data-testid="updates-other"][data-part="boite"]')).toHaveLength(1); });
  const row = one('updates-other')!;
  expect(row.textContent).toContain('builder');
  expect(row.textContent).toContain('2.0.0-beta.2');
  expect(one('app-update-status')!.textContent).toContain(strings.serverUpdate.current);
  one<HTMLButtonElement>('updates-run-all')!.click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('core.updateEverything', expect.objectContaining({ server: '2.0.0-beta.2' })));
  expect(otherCall).not.toHaveBeenCalledWith('core.updateEverything', expect.anything());
  await vi.waitFor(() => { flushSync(); expect(one('server-update-cancel')).not.toBeNull(); });
  one<HTMLButtonElement>('server-update-cancel')!.click();
  await vi.waitFor(() => expect(server.store.serverUpdater.snapshot?.phase).toBe('available'));
});

test('a browser has no app updater: it shows the version of the machine it is on and no channel', async () => {
  await machine('builder', false);
  view = mount(UpdatesCard, { target: document.body, props: { native: false } });
  flushSync();
  expect(one('updates-version')!.textContent).toContain(workspace.active.core!.version);
  expect(one('app-update-nightly')).toBeNull();
  expect(one<HTMLButtonElement>('updates-run-all')!.disabled).toBe(true);
});

test('a server too old for the button says it updates once by hand, and a paired device asks it nothing', async () => {
  const { store, client } = await machine('older', false);
  const original = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'core.updateStatus'
    ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method core.updateStatus' })) : original(method, params));
  store.serverUpdater.reset(); await store.serverUpdater.load();
  expect(store.error).toBeNull();
  view = mount(MachinesPage, { target: document.body, props: {} });
  await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-machine-id="older"] .info-tip')).not.toBeNull(); });
  unmount(view, { outro: false }); view = undefined; document.body.innerHTML = '';
  history.replaceState(null, '', '/?fake=1&serverUpdate=available');
  const paired = new Store(); stores.push(paired);
  const pairedClient = new FakeClient({ delayMs: 0, principal: 'session' });
  paired.attach(pairedClient); await paired.connect();
  const call = vi.spyOn(pairedClient, 'call');
  await paired.serverUpdater.load();
  expect(call).not.toHaveBeenCalledWith('core.updateStatus', expect.anything());
});

test('a late status response cannot undo a newer update event', async () => {
  const { store, client } = await machine('builder', false);
  const current = store.serverUpdater.snapshot!;
  let finish!: (value: ServerUpdateStatus) => void;
  const original = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'core.updateStatus'
    ? new Promise(resolve => { finish = resolve; }) : original(method, params));
  const read = store.serverUpdater.load();
  store.serverUpdater.apply({ ...current, phase: 'waiting', version: '2.1.0' });
  finish(current); await read;
  expect(store.serverUpdater.snapshot?.phase).toBe('waiting');
});

test('two machines under one name keep their own rows, and a refused cancel says why', async () => {
  const { updater } = await app(nightly('current'));
  const first = await machine('server-a', true);
  const second = await machine('server-b', true);
  workspace.machines = workspace.machines.map((entry) => ({ ...entry, label: 'Server' }));
  view = mount(UpdatesCard, { target: document.body, props: { updater, native: true } });
  await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('[data-testid="updates-other"][data-part="boite"]')).toHaveLength(2); });
  one<HTMLButtonElement>('updates-run-all')!.click();
  await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('[data-testid="server-update-cancel"]')).toHaveLength(2); });
  const original = second.client.call.bind(second.client);
  vi.spyOn(second.client, 'call').mockImplementation((method, params) => method === 'core.updateCancel'
    ? Promise.reject(new Error('the download is already verified')) : original(method, params));
  document.querySelectorAll<HTMLButtonElement>('[data-testid="server-update-cancel"]')[1]!.click();
  await vi.waitFor(() => { flushSync(); expect(one('updates-failure')?.textContent).toContain('the download is already verified'); });
  expect(first.store.serverUpdater.error).toBeNull();
});

test('this computer installs updates by itself only once its own switch is on, saved on its core', async () => {
  const { updater } = await app(nightly('current'));
  const { store: here } = await machine('here', false);
  const { store: server } = await machine('server', false);
  view = mount(UpdatesCard, { target: document.body, props: { updater, native: true } });
  flushSync();
  // No core started by this window's shell: nothing to save the choice on.
  expect(one('app-update-auto')).toBeNull();
  here.localCore = true;
  flushSync();
  const toggle = one<HTMLInputElement>('app-update-auto-switch')!;
  expect(one('app-update-auto')!.textContent).toContain(strings.appUpdate.autoInstall);
  expect([toggle.checked, toggle.getAttribute('role')]).toEqual([false, 'switch']);
  toggle.click();
  await vi.waitFor(() => expect(here.settings?.autoInstallUpdates).toBe(true));
  expect(server.settings?.autoInstallUpdates ?? false).toBe(false);
});

test('a browser has no updater to install by itself: the switch is not drawn', async () => {
  const { store } = await machine('here', false);
  store.localCore = true;
  view = mount(UpdatesCard, { target: document.body, props: { native: false } });
  flushSync();
  expect(one('app-update-auto')).toBeNull();
});
