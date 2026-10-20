import { hostname } from 'node:os';
import { afterEach, expect, test } from 'bun:test';
import type { DesktopUpdateStatus, ProviderDescriptor, ProviderId } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore | null = null;
const clients: CoreClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await harness?.stop();
  harness = null;
});

const offered: DesktopUpdateStatus = { phase: 'available', currentVersion: '2.0.0-beta.1', version: '2.0.0-beta.2', channel: 'stable', received: 0, total: null, error: null };

async function start(): Promise<TestCore> {
  harness = await startTestCore();
  return harness;
}

/** This machine's own desktop window: the core token, on loopback, from the shell. */
async function window(h: TestCore): Promise<CoreClient> {
  const client = await connect(h.url, h.token, { client: { name: 'shell', version: '2.0.0-beta.1' } });
  clients.push(client);
  return client;
}

/** Another machine of the group: owner rights, through a session. */
async function member(h: TestCore): Promise<CoreClient> {
  const owner = await h.connect();
  const { grant } = await owner.call('pairing.grant', { role: 'owner' });
  const client = await connect(h.url, '', { grant, client: { name: 'shell', version: '2.0.0-beta.1' } });
  clients.push(client);
  return client;
}

test('only this machine\'s own window reports its updater, and its report lasts as long as its socket', async () => {
  const h = await start();
  expect(h.core.info().features?.desktopUpdates).toBe(true);
  const remote = await member(h);
  const changes: (DesktopUpdateStatus | null)[] = [];
  remote.on('core.desktopUpdateChanged', ({ status }) => changes.push(status));
  expect(await remote.call('core.desktopUpdateStatus', {})).toBeNull();

  // A member of the group, a browser tab with the token and the CLI hold no installer here.
  expect(await thrown(remote.call('core.desktopUpdateReport', { status: offered }))).toThrow('own desktop window only');
  const tab = await connect(h.url, h.token, { client: { name: 'pwa', version: '1' } });
  clients.push(tab);
  expect(await thrown(tab.call('core.desktopUpdateReport', { status: offered }))).toThrow('own desktop window only');
  const plugin = await connect(h.url, h.token, { client: { name: 'plugin', version: '1' } });
  clients.push(plugin);
  expect(await thrown(plugin.call('core.desktopUpdateReport', { status: offered }))).toThrow('own desktop window only');
  // A phone holds no owner method at all.
  const owner = await h.connect();
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'pwa', version: '1' } });
  clients.push(phone);
  expect(await thrown(phone.call('core.desktopUpdateStatus', {}))).toThrow('owner only');

  const local = await window(h);
  expect(await thrown(local.call('core.desktopUpdateReport', { status: { ...offered, phase: 'gone' } as never }))).toThrow('status.phase must be one of');
  expect(await thrown(local.call('core.desktopUpdateReport', { status: { ...offered, received: -1 } }))).toThrow('status.received');
  expect(await local.call('core.desktopUpdateReport', { status: offered })).toEqual({ ok: true });
  expect(await remote.call('core.desktopUpdateStatus', {})).toEqual(offered);
  await waitFor(() => changes.length === 1);
  expect(changes[0]).toEqual(offered);

  local.close();
  await waitFor(() => changes.length === 2);
  expect(changes[1]).toBeNull();
  expect(await remote.call('core.desktopUpdateStatus', {})).toBeNull();
});

test('no window open names the machine; a release the window does not offer is refused', async () => {
  const h = await start();
  const remote = await member(h);
  const none = await remote.call('core.updateEverything', { agents: [], server: null, app: '2.0.0-beta.2' });
  expect(none.app).toBeNull();
  expect(none.appError).toBe(`Boite is not open on ${hostname()}`);
  expect(await thrown(remote.call('core.updateEverything', { agents: [], server: null, app: 7 as never }))).toThrow('core.updateEverything.app');

  const local = await window(h);
  await local.call('core.desktopUpdateReport', { status: offered });
  const stale = await remote.call('core.updateEverything', { agents: [], server: null, app: '2.0.0-beta.9' });
  expect(stale.appError).toBe(`The desktop app on ${hostname()} offers 2.0.0-beta.2, not 2.0.0-beta.9`);
  // Without `app` nothing changes for a client from before it.
  const old = await remote.call('core.updateEverything', { agents: [], server: null });
  expect(old.appError).toBeNull();
});

test('the install order reaches this machine\'s window alone, once the agents it started are done', async () => {
  const h = await start();
  const local = await window(h);
  const tab = await connect(h.url, h.token, { client: { name: 'pwa', version: '1' } });
  clients.push(tab);
  const remote = await member(h);
  const heard: { who: string; version: string }[] = [];
  local.on('ui.appUpdate', ({ version }) => heard.push({ who: 'window', version }));
  tab.on('ui.appUpdate', ({ version }) => heard.push({ who: 'tab', version }));
  remote.on('ui.appUpdate', ({ version }) => heard.push({ who: 'member', version }));
  await local.call('core.desktopUpdateReport', { status: offered });

  // An agent whose update runs until the test lets it end.
  let busy = true;
  const agent = 'agent-under-update' as ProviderId;
  h.core.providers.require = ((id: ProviderId) => ({ id })) as unknown as (id: ProviderId) => ProviderDescriptor;
  h.core.updates.updating = (id: ProviderId) => id === agent && busy;

  const answer = await remote.call('core.updateEverything', { agents: [agent], server: null, app: '2.0.0-beta.2' });
  expect(answer.agents).toEqual([agent]);
  expect(answer.appError).toBeNull();
  expect(answer.app).toEqual(offered);
  await Bun.sleep(600);
  expect(heard).toEqual([]);

  busy = false;
  await waitFor(() => heard.length > 0);
  await Bun.sleep(100);
  expect(heard).toEqual([{ who: 'window', version: '2.0.0-beta.2' }]);

  // Once the window says it installs, asking again sends nothing more.
  await local.call('core.desktopUpdateReport', { status: { ...offered, phase: 'waiting' } });
  expect((await remote.call('core.updateEverything', { agents: [], server: null, app: '2.0.0-beta.2' })).appError).toBeNull();
  await Bun.sleep(400);
  expect(heard).toHaveLength(1);

  // The window closes to install: the machine keeps reading as installing until its next core starts.
  local.close();
  await Bun.sleep(200);
  expect(await remote.call('core.desktopUpdateStatus', {})).toEqual({ ...offered, phase: 'waiting' });
  expect((await remote.call('core.updateEverything', { agents: [], server: null, app: '2.0.0-beta.3' })).appError).toBe(`Boite is not open on ${hostname()}`);
});
