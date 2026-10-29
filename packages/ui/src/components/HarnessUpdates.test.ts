import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import AccountsPage from './AccountsPage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const stores: Store[] = [];
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  workspace.machines = [];
  workspace.active = primary;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function machine(id: string, label: string): Promise<Store> {
  const store = new Store(); stores.push(store);
  store.machineId = id;
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect(); await settle();
  workspace.machines = [...workspace.machines, { id, label, store }];
  workspace.active = workspace.machines[0]!.store;
  return store;
}
const row = (provider: string) => document.querySelector<HTMLElement>(`[data-testid="machine-agent-update"][data-provider-id="${provider}"]`)!;
/** A machine's Providers page, where its agents' versions and updates live. */
async function showProviders(store: Store) {
  if (mounted) await unmount(mounted);
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  await settle();
}

test('Providers routes Update and Skip to the machine it shows even with matching provider IDs', async () => {
  vi.useFakeTimers();
  const local = await machine('local', 'This PC');
  const remote = await machine('remote', 'Builder');
  await showProviders(local);
  expect(document.querySelector('[data-testid="harness-update-notice"]')).toBeNull();
  expect(row('claude').textContent).toContain('2.1.267 → 2.1.278');
  row('claude').querySelector<HTMLButtonElement>('[data-testid="harness-update-skip"]')!.click();
  await settle();
  expect(local.harnessUpdates.find(update => update.providerId === 'claude')).toMatchObject({ pending: false, skipped: '2.1.278' });
  expect(remote.harnessUpdates.find(update => update.providerId === 'claude')?.pending).toBe(true);
  row('claude').querySelector<HTMLButtonElement>('[data-testid="harness-update-unskip"]')!.click();
  await settle();
  expect(local.harnessUpdates.find(update => update.providerId === 'claude')).toMatchObject({ pending: true, skipped: null });
  await showProviders(remote);
  row('codex').querySelector<HTMLButtonElement>('[data-testid="harness-update-row-run"]')!.click();
  await settle();
  expect(remote.harnessUpdates.find(update => update.providerId === 'codex')?.state).toBe('updating');
  expect(row('codex').textContent).toContain('Updating');
  expect(local.harnessUpdates.find(update => update.providerId === 'codex')?.pending).toBe(true);
  await vi.advanceTimersByTimeAsync(1500); await settle();
  expect(remote.harnessUpdates.find(update => update.providerId === 'codex')).toMatchObject({ current: '0.155.1', pending: false });
  expect(workspace.active).toBe(local);
});

test('failed updates retain their reason and retry and unknown releases keep their own updater', async () => {
  vi.useFakeTimers();
  const local = await machine('local', 'This PC');
  local.harnessUpdates = local.harnessUpdates.map(update => update.providerId === 'claude'
    ? { ...update, state: 'failed', pending: true, message: 'the disk is full' } : update);
  await showProviders(local);
  expect(row('claude').textContent).toContain('the disk is full');
  expect(row('claude').querySelector('[data-testid="harness-update-row-run"]')!.textContent).toContain('Try again');
  const blind = row('grok');
  expect(blind.querySelector('.version')?.getAttribute('title')).toContain('Checks by itself');
  blind.querySelector<HTMLButtonElement>('[data-testid="harness-update-row-blind"]')!.click();
  await settle(); await vi.advanceTimersByTimeAsync(1500); await settle();
  expect(blind.querySelector('[data-testid="harness-update-current"]')).not.toBeNull();
  expect(blind.querySelector('[data-testid="harness-update-row-blind"]')).toBeNull();
});

test('the Machines page lists no agent and starts no agent check of its own', async () => {
  const local = await machine('local', 'This PC');
  const load = vi.spyOn(local, 'loadHarnessUpdates');
  const { default: MachinesPage } = await import('./MachinesPage.svelte');
  mounted = mount(MachinesPage, { target: document.body, props: {} });
  await settle();
  // Versions live on each machine's Providers page; Machines only says an update is waiting.
  expect(document.querySelector('[data-testid="machines-page"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="harness-updates-card"]')).toBeNull();
  expect(document.querySelector('[data-testid="machine-agent-update"]')).toBeNull();
  expect(load).not.toHaveBeenCalled();
});

test('Providers refreshes an empty reading once, disables actions after disconnection, and shows a paired device nothing', async () => {
  const local = await machine('local', 'This PC');
  local.harnessUpdates = [];
  const load = vi.spyOn(local, 'loadHarnessUpdates');
  await showProviders(local);
  expect(load).toHaveBeenCalledExactlyOnceWith(true);
  local.connection = 'closed'; await settle();
  const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="harness-updates-card"] button:not(.info-tip)')];
  expect(actions.length).toBeGreaterThan(2);
  expect(actions.every(button => button.disabled)).toBe(true);
  expect(document.querySelector<HTMLInputElement>('[data-testid="setting-auto-update-harnesses"]')!.disabled).toBe(true);
  local.principal = 'session'; await settle();
  expect(document.querySelector('[data-testid="harness-updates-card"]')).toBeNull();
});
