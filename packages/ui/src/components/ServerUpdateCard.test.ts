import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode, type ServerUpdateStatus } from '@boite/contracts';
import ServerUpdateCard from './ServerUpdateCard.svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { confirm } from '../lib/confirm.svelte';
import { RpcFailure } from '../lib/client';

let view: ReturnType<typeof mount> | undefined;
const stores: Store[] = [];
afterEach(() => {
  if (view) unmount(view, { outro: false }); view = undefined;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  confirm.answer(false); document.body.innerHTML = ''; history.replaceState(null, '', '/');
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); flushSync(); };
async function machine(offered = true, principal: 'owner' | 'session' = 'owner') {
  history.replaceState(null, '', offered ? '/?fake=1&serverUpdate=available' : '/?fake=1');
  const store = new Store(); stores.push(store);
  const client = new FakeClient({ delayMs: 0, principal }); store.attach(client); await store.connect();
  if (principal === 'owner') await store.serverUpdater.load();
  return { store, client };
}

test('a server at the current version offers a manual check and no update action', async () => {
  const { store } = await machine(false);
  view = mount(ServerUpdateCard, { target: document.body, props: { store, label: 'Build server' } });
  expect(document.querySelector('[data-testid=server-update-install]')).toBeNull();
  expect(document.querySelector('[data-testid=server-update-check]')).not.toBeNull();
  expect(document.querySelector('[data-testid=server-update-status]')?.textContent).toBe('Up to date');
});

test('a confirmed update stays with its owning machine, shows waiting and can be cancelled', async () => {
  const { store, client } = await machine();
  const other = await machine();
  const call = vi.spyOn(client, 'call');
  const otherCall = vi.spyOn(other.client, 'call');
  view = mount(ServerUpdateCard, { target: document.body, props: { store, label: 'Build server' } });
  document.querySelector<HTMLButtonElement>('[data-testid=server-update-install]')!.click();
  await flush();
  expect(confirm.current?.title).toBe('Update Build server?');
  confirm.answer(true);
  await vi.waitFor(() => expect(store.serverUpdater.snapshot?.phase).toBe('waiting'));
  flushSync();
  expect(call).toHaveBeenCalledWith('core.updateInstall', { version: '2.0.0-beta.2' });
  expect(otherCall).not.toHaveBeenCalledWith('core.updateInstall', expect.anything());
  expect(document.querySelector('[data-testid=server-update-install]')).toBeNull();
  expect(document.querySelector('[data-testid=server-update-cancel]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid=server-update-cancel]')!.click();
  await vi.waitFor(() => expect(store.serverUpdater.snapshot?.phase).toBe('available'));
  flushSync();
  expect(document.querySelector('[data-testid=server-update-install]')).not.toBeNull();
});

test('an older server explains its first manual update and a paired device cannot install', async () => {
  const { store, client } = await machine(false);
  const original = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'core.updateStatus'
    ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method core.updateStatus' })) : original(method, params));
  store.serverUpdater.reset(); await store.serverUpdater.load();
  view = mount(ServerUpdateCard, { target: document.body, props: { store, label: 'Older server' } });
  expect(document.body.textContent).toContain('Update it once');
  expect(store.error).toBeNull();
  expect(document.querySelector('[data-testid=server-update-install]')).toBeNull();
  unmount(view, { outro: false }); view = undefined; document.body.innerHTML = '';
  const paired = await machine(true, 'session');
  const call = vi.spyOn(paired.client, 'call');
  view = mount(ServerUpdateCard, { target: document.body, props: { store: paired.store, label: 'Paired server' } });
  expect(document.querySelector('[data-testid=server-update-install]')).toBeNull();
  expect(call).not.toHaveBeenCalledWith('core.updateStatus', expect.anything());
});

test('a late status response cannot undo a newer update event', async () => {
  const { store, client } = await machine(false);
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

test("another PC's desktop app replaces the manual server guide, installs on a confirmed click and names a closed window", async () => {
  history.replaceState(null, '', '/?fake=1&desktopUpdate=available');
  const store = new Store(); stores.push(store);
  const client = new FakeClient({ delayMs: 0, desktopApp: true }); store.attach(client); await store.connect();
  await vi.waitFor(() => expect(store.serverUpdater.desktop?.phase).toBe('available'));
  await store.serverUpdater.load();
  const call = vi.spyOn(client, 'call');
  view = mount(ServerUpdateCard, { target: document.body, props: { store, label: 'PC B' } });
  flushSync();
  expect(document.querySelector('.disclosure')).toBeNull();
  expect(document.querySelector('[data-testid=desktop-update-target]')?.textContent).toBe('2.0.0-beta.2');
  document.querySelector<HTMLButtonElement>('[data-testid=desktop-update-install]')!.click();
  await flush();
  expect(confirm.current?.title).toBe('Update Boite on PC B?');
  confirm.answer(true);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('core.updateEverything', { agents: [], server: null, app: '2.0.0-beta.2' }));
  await vi.waitFor(() => expect(store.serverUpdater.desktop?.phase).toBe('downloading'));
  flushSync();
  expect(document.querySelector('[data-testid=desktop-update-install]')).toBeNull();

  // The window there closed before the click: the reason shows and the button retries.
  call.mockImplementationOnce(async () => ({ agents: [], failed: [], server: store.serverUpdater.snapshot!, serverError: null, app: null, appError: 'Boite is not open on Builder' }) as never);
  store.serverUpdater.applyDesktop(null);
  await store.serverUpdater.everything([], null, '2.0.0-beta.3');
  flushSync();
  expect(document.querySelector('[data-testid=desktop-update-status]')?.textContent).toBe('Boite is not open on Builder');
  expect(document.querySelector('[data-testid=desktop-update-install]')?.textContent).toBe('Try again');
});
