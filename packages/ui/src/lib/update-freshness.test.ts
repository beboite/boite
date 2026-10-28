import { afterEach, expect, test, vi } from 'vitest';
import type { HarnessUpdate, ServerUpdateStatus } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { AppUpdater, type AppUpdateBackend, type UpdateSnapshot } from './app-update.svelte';
import { UPDATE_STALE_MS, freshenUpdates } from './update-freshness';

const stores: Store[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  vi.restoreAllMocks();
});

const HOURS = 60 * 60_000;

/**
 * A server whose core last checked `age` ago and said up to date, while a
 * release came out since: only a new check finds it, as on the real core.
 */
/** `age` null: never read. `fresh` names the one agent read a moment ago. */
async function server(age: number | null, fresh: string | null = null) {
  const client = new FakeClient({ delayMs: 0, coreId: 'server', coreName: 'server' });
  const call = client.call.bind(client);
  const checkedAt = age === null ? null : Date.now() - age;
  const reading: ServerUpdateStatus = { mode: 'systemd', phase: 'current', currentVersion: '2.0.0-nightly.20261024.1', version: null,
    channel: 'nightly', publishedAt: null, checkedAt, received: 0, total: null, error: null };
  const found: ServerUpdateStatus = { ...reading, phase: 'available', version: '2.0.0-nightly.20261028.1', publishedAt: '2026-10-28T10:02:51Z', checkedAt: Date.now() };
  const spy = vi.spyOn(client, 'call').mockImplementation((async (method: string, params: { refresh?: boolean }) => {
    if (method === 'core.updateStatus') return params.refresh ? found : reading;
    if (method === 'providers.updates' && !params.refresh) return (await call('providers.updates', {}))
      .map((update): HarnessUpdate => ({ ...update, checkedAt: update.providerId === fresh ? Date.now() : checkedAt }));
    return call(method as never, params as never);
  }) as typeof client.call);
  const store = new Store(); stores.push(store);
  store.attach(client);
  await store.connect();
  const refreshes = (method: string) => spy.mock.calls.filter(([name, params]) => name === method && (params as { refresh?: boolean }).refresh === true).length;
  return { store, refreshes };
}

test('connecting to a machine whose last check is hours old checks its Boite and agents again', async () => {
  const { store, refreshes } = await server(3 * HOURS);
  // Before: the core's six-hour reading said up to date and nothing asked again until a manual check.
  await vi.waitFor(() => expect(store.serverUpdater.snapshot?.phase).toBe('available'));
  expect(store.serverUpdater.snapshot?.version).toBe('2.0.0-nightly.20261028.1');
  await vi.waitFor(() => expect(refreshes('providers.updates')).toBe(1));
  expect(refreshes('core.updateStatus')).toBe(1);
});

test('one agent updated a moment ago does not hide the others\' stale or missing readings', async () => {
  // Updating Claude stamps only its row: the other agents still go hours unchecked, or were never read.
  for (const age of [3 * HOURS, null]) {
    const { refreshes } = await server(age, 'claude');
    await vi.waitFor(() => expect(refreshes('providers.updates')).toBe(1));
  }
});

test('a reading taken minutes ago is shown as it is, without a new check', async () => {
  const { store, refreshes } = await server(60_000);
  await vi.waitFor(() => expect(store.serverUpdater.snapshot?.phase).toBe('current'));
  await vi.waitFor(() => expect(store.harnessUpdates.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect([refreshes('core.updateStatus'), refreshes('providers.updates')]).toEqual([0, 0]);
});

test('the window shown again checks what went stale meanwhile, this computer\'s app included', async () => {
  const { store, refreshes } = await server(60_000);
  await vi.waitFor(() => expect(store.harnessUpdates.length).toBeGreaterThan(0));
  const app = { checkIfStale: vi.fn() };
  const later = Date.now() + UPDATE_STALE_MS + 60_000;
  freshenUpdates([store], app, later);
  expect(app.checkIfStale).toHaveBeenCalledWith(later);
  await vi.waitFor(() => expect(store.serverUpdater.snapshot?.phase).toBe('available'));
  await vi.waitFor(() => expect(refreshes('providers.updates')).toBe(1));
});

test('the desktop app checks again when shown after its last check went stale, not before', async () => {
  const snapshot: UpdateSnapshot = { phase: 'current', currentVersion: '2.0.0-nightly.20261027.1', currentChannel: 'nightly', channel: 'nightly',
    version: null, notes: null, publishedAt: null, received: 0, total: null, error: null, supported: true };
  const native: AppUpdateBackend = {
    status: vi.fn(async () => snapshot), check: vi.fn(async () => snapshot), download: vi.fn(async () => snapshot),
    install: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined)
  };
  vi.useFakeTimers();
  try {
    const updater = new AppUpdater(native, undefined, () => true);
    stops.push(updater.start());
    // Before the startup check, the timer decides.
    updater.checkIfStale(Date.now() + 2 * UPDATE_STALE_MS);
    expect(native.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    await updater.settled();
    expect(native.check).toHaveBeenCalledTimes(1);
    updater.checkIfStale(Date.now() + 60_000);
    expect(native.check).toHaveBeenCalledTimes(1);
    updater.checkIfStale(Date.now() + UPDATE_STALE_MS + 60_000);
    await updater.settled();
    expect(native.check).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
