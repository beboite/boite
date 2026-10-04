import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RpcMethodName } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

const stores: Store[] = [];
const clients: FakeClient[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const store of stores.splice(0)) store.detach();
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function ready(store = new Store(), client = new FakeClient({ delayMs: 0 })) {
  if (!stores.includes(store)) stores.push(store);
  if (!clients.includes(client)) clients.push(client);
  store.attach(client);
  await store.connect();
  await store.reload();
  await store.loadHarnessUpdates();
  return { store, client };
}

/** Delay the actual fake RPC at its transport boundary, without replacing its result. */
function hold(client: FakeClient, methods: RpcMethodName[], before = false) {
  const gates = methods.map(method => ({ method, entered: deferred(), release: deferred(), used: false }));
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const gate = gates.find(entry => entry.method === method && !entry.used);
    if (gate) gate.used = true;
    if (gate && before) { gate.entered.resolve(); await gate.release.promise; }
    const result = await call(method, params).then(value => ({ value }), error => ({ error }));
    if (gate && !before) { gate.entered.resolve(); await gate.release.promise; }
    if ('error' in result) throw result.error;
    return result.value;
  });
  return {
    entered: Promise.all(gates.map(gate => gate.entered.promise)),
    release: () => { for (const gate of gates) gate.release.resolve(); }
  };
}

test('old update refreshes and provider failures leave replacement feedback and warnings alone', async () => {
  const { store, client } = await ready();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const gate = hold(client, ['providers.updates', 'providers.updates', 'providers.update', 'providers.install', 'providers.uninstall', 'providers.reload', 'accounts.login', 'accounts.check'], true);
  const pending = Promise.all([
    store.loadHarnessUpdates(true), store.loadHarnessUpdates(), store.updateHarness('claude'),
    store.installProvider('antigravity'), store.uninstallProvider('opencode'), store.reloadProviders(),
    store.loginAccount('a-claude-side'), store.checkAccount('a-echo')
  ]);
  try {
    await gate.entered;
    await ready(store);
    store.error = 'Feedback from the replacement machine';
    warn.mockClear(); error.mockClear();
    client.close();
    gate.release();
    await pending;
    expect(store.error).toBe('Feedback from the replacement machine');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally { gate.release(); await pending; }
});

test('an update snapshot from before same-client reattachment cannot undo a newer skip', async () => {
  const { store, client } = await ready();
  const gate = hold(client, ['providers.updates']);
  const pending = store.loadHarnessUpdates(true);
  try {
    await gate.entered;
    await ready(store, client);
    await store.skipHarnessUpdate('claude', '2.1.278');
    expect(store.harnessUpdates.find(update => update.providerId === 'claude')?.skipped).toBe('2.1.278');
    gate.release(); await pending;
    expect(store.harnessUpdates.find(update => update.providerId === 'claude')?.skipped).toBe('2.1.278');
  } finally { gate.release(); await pending; }
});

test('late managed operation replies cannot overwrite the replacement provider snapshots', async () => {
  const { store, client } = await ready();
  const gate = hold(client, ['providers.update', 'providers.updateSkip', 'providers.install', 'providers.uninstall', 'providers.reload']);
  const pending = Promise.all([
    store.updateHarness('claude'), store.skipHarnessUpdate('codex', '0.155.1'),
    store.installProvider('antigravity'), store.uninstallProvider('opencode'), store.reloadProviders()
  ]);
  try {
    await gate.entered;
    await ready(store);
    const updates = JSON.parse(JSON.stringify(store.harnessUpdates));
    const installs = JSON.parse(JSON.stringify(store.installStates));
    const providers = JSON.parse(JSON.stringify(store.providers));
    gate.release();
    const result = await pending;
    expect(store.harnessUpdates).toEqual(updates);
    expect(store.installStates).toEqual(installs);
    expect(store.providers).toEqual(providers);
    expect(result[2]).toBe(false);
    expect(result[4]).toBe(false);
  } finally { gate.release(); await pending; }
});

test('same-client reattachment keeps the new install operation and cancellation owns that operation', async () => {
  const { store, client } = await ready();
  const gate = hold(client, ['providers.install']);
  const pending = store.installProvider('antigravity');
  try {
    await gate.entered;
    const old = store.installOf('antigravity');
    expect(old?.state).toBe('downloading');
    await store.cancelInstall('antigravity');
    await ready(store, client);
    expect(await store.installProvider('antigravity')).toBe(true);
    const current = store.installOf('antigravity');
    expect(current?.state).toBe('downloading');
    if (!current || current.state !== 'downloading' || !old || old.state !== 'downloading') throw new Error('Expected running installs');
    expect(current.operationId).not.toBe(old.operationId);
    gate.release();
    const accepted = await pending;
    expect(store.installOf('antigravity')).toEqual(current);
    expect(accepted).toBe(false);
    await store.cancelInstall('antigravity');
    expect(vi.mocked(client.call)).toHaveBeenLastCalledWith('providers.installCancel', { providerId: 'antigravity', operationId: current.operationId });
    expect(store.installOf('antigravity')?.state).toBe('absent');
  } finally { gate.release(); await pending; }
});

test('late account addition, rename and removal preserve the replacement accounts with colliding ids', async () => {
  const { store, client } = await ready();
  const gate = hold(client, ['accounts.add', 'accounts.rename', 'accounts.remove']);
  const pending = Promise.all([
    store.addAccount({ providerId: 'claude', label: 'Old account' }),
    store.renameAccount('a-echo', 'Old label'), store.removeAccount('a-claude-side')
  ]);
  try {
    await gate.entered;
    await ready(store);
    const accounts = JSON.parse(JSON.stringify(store.accounts));
    gate.release();
    const result = await pending;
    expect(store.accounts).toEqual(accounts);
    expect(result[0]).toBeNull();
    expect(result[1]).toBe(false);
    const added = await store.addAccount({ providerId: 'claude', label: 'Current account' });
    expect(added).not.toBeNull();
    expect(store.accountOf(added!.id)?.label).toBe('Current account');
    expect(await store.renameAccount(added!.id, 'Current label')).toBe(true);
    expect((await store.checkAccount(added!.id))?.label).toBe('Current label');
    await store.removeAccount(added!.id);
    expect(store.accountOf(added!.id)).toBeNull();
  } finally { gate.release(); await pending; }
});

test('same-client account checks and login cancellation cannot replace a newer label or login', async () => {
  const { store, client } = await ready();
  await store.loginAccount('a-claude-side');
  const gate = hold(client, ['accounts.check', 'accounts.loginCancel']);
  const checking = store.checkAccount('a-echo');
  const cancelling = store.cancelLogin('a-claude-side');
  try {
    await gate.entered;
    await ready(store, client);
    expect(await store.renameAccount('a-echo', 'Current label')).toBe(true);
    await store.loginAccount('a-claude-side');
    expect(store.logins['a-claude-side']?.state).toBe('running');
    gate.release();
    const account = await checking; await cancelling;
    expect(store.accountOf('a-echo')?.label).toBe('Current label');
    expect(store.logins['a-claude-side']?.state).toBe('running');
    expect(account).toBeNull();
    expect(await client.call('accounts.logins', {})).toHaveLength(1);
    await store.cancelLogin('a-claude-side');
    expect(store.logins['a-claude-side']).toBeUndefined();
  } finally { gate.release(); await checking; await cancelling; }
});

test('provider reload stops follow-up account checks after replacement during an awaited check', async () => {
  const { store, client } = await ready();
  const gate = hold(client, ['accounts.check']);
  const pending = store.reloadProviders();
  try {
    await gate.entered;
    const { client: replacement } = await ready(store);
    const calls = vi.spyOn(replacement, 'call');
    gate.release();
    const accepted = await pending;
    expect(calls.mock.calls.filter(([method]) => method === 'accounts.check')).toEqual([]);
    expect(accepted).toBe(false);
  } finally { gate.release(); await pending; }
});

test('a proxied provider shows one gateway account over its local ones, which come back when the proxy goes off', async () => {
  const { store, client } = await ready();
  const douane = { enabled: true, kind: 'douane' as const, baseUrl: 'http://gateway.test:8787/v1', dashboardUrl: 'http://gateway.test:8787/admin/#quotas' };
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: douane });
  // One account, the first local id under the gateway's name: a thread on either seat still resolves.
  expect(store.accountsOf('claude').map(account => [account.id, account.label, account.status, account.identity])).toEqual([['a-claude-main', 'Douane', 'ok', null]]);
  expect(store.accountOf('a-claude-side')).toMatchObject({ id: 'a-claude-side', label: 'Douane', status: 'ok' });
  expect(store.gatewayOf('codex')).toEqual({ kind: 'douane', name: 'Douane', origin: 'http://gateway.test:8787' });
  // Other protocols keep their own sign-ins, and nothing was written to the accounts.
  expect(store.gatewayOf('opencode')).toBeNull();
  expect(store.accountsOf('opencode')[0]!.label).toBe('Default');
  expect(store.accounts.filter(account => account.providerId === 'claude').map(account => account.label)).toEqual(['Default login', 'Second seat']);
  expect((await client.call('accounts.list', {})).some(account => account.label === 'Douane')).toBe(false);

  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: { ...douane, kind: 'cliproxyapi' } });
  expect(store.accountsOf('claude')[0]!.label).toBe('CLIProxyAPI');
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: { ...douane, enabled: false } });
  expect(store.accountsOf('claude').map(account => [account.label, account.status])).toEqual([['Default login', 'ok'], ['Second seat', 'unauthenticated']]);
  expect(store.accountOf('a-claude-side')!.label).toBe('Second seat');
});