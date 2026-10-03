import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import MachinesPage from './MachinesPage.svelte';
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
const row = (machine: string, provider: string) => document.querySelector<HTMLElement>(`[data-machine-id="${machine}"] [data-testid="machine-agent-update"][data-provider-id="${provider}"]`)!;
async function showMachines() {
  mounted = mount(MachinesPage, { target: document.body, props: { mobile: true } });
  await settle();
}

test('Machines routes Update and Skip to the owning core even with matching provider IDs', async () => {
  vi.useFakeTimers();
  const local = await machine('local', 'This PC');
  const remote = await machine('remote', 'Builder');
  await showMachines();
  expect(document.querySelector('[data-testid="harness-update-notice"]')).toBeNull();
  expect(row('local', 'claude').textContent).toContain('2.1.267 → 2.1.278');
  row('local', 'claude').querySelector<HTMLButtonElement>('[data-testid="harness-update-skip"]')!.click();
  await settle();
  expect(local.harnessUpdates.find(update => update.providerId === 'claude')).toMatchObject({ pending: false, skipped: '2.1.278' });
  expect(remote.harnessUpdates.find(update => update.providerId === 'claude')?.pending).toBe(true);
  row('local', 'claude').querySelector<HTMLButtonElement>('[data-testid="harness-update-unskip"]')!.click();
  await settle();
  expect(local.harnessUpdates.find(update => update.providerId === 'claude')).toMatchObject({ pending: true, skipped: null });
  row('remote', 'codex').querySelector<HTMLButtonElement>('[data-testid="harness-update-row-run"]')!.click();
  await settle();
  expect(remote.harnessUpdates.find(update => update.providerId === 'codex')?.state).toBe('updating');
  expect(row('remote', 'codex').textContent).toContain('Updating');
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
  await showMachines();
  expect(row('local', 'claude').textContent).toContain('the disk is full');
  expect(row('local', 'claude').querySelector('[data-testid="harness-update-row-run"]')!.textContent).toContain('Try again');
  const blind = row('local', 'antigravity-cli');
  expect(blind.querySelector('.version')?.getAttribute('title')).toContain('Checks by itself');
  blind.querySelector<HTMLButtonElement>('[data-testid="harness-update-row-blind"]')!.click();
  await settle(); await vi.advanceTimersByTimeAsync(1500); await settle();
  expect(blind.querySelector('[data-testid="harness-update-current"]')).not.toBeNull();
  expect(blind.querySelector('[data-testid="harness-update-row-blind"]')).toBeNull();
});

test('Providers retains installed versions without update controls or starting checks', async () => {
  const local = await machine('local', 'This PC');
  const load = vi.spyOn(local, 'loadHarnessUpdates');
  mounted = mount(AccountsPage, { target: document.body, props: { store: local } });
  await settle();
  const version = document.querySelector('[data-update-provider="claude"]')!;
  expect(version.textContent?.trim()).toBe('2.1.267');
  expect(document.querySelector('[data-testid="harness-updates-check"]')).toBeNull();
  expect(document.querySelector('[data-testid="setting-auto-update-harnesses"]')).toBeNull();
  expect(document.querySelector('[data-testid="harness-update-row-run"]')).toBeNull();
  expect(document.querySelector('[data-testid="harness-update-row-blind"]')).toBeNull();
  expect(load).not.toHaveBeenCalled();
  local.harnessUpdates = []; await settle();
  expect(load).not.toHaveBeenCalled();
});

test('Machines refreshes an empty reading once and disables actions after disconnection', async () => {
  const local = await machine('local', 'This PC');
  local.harnessUpdates = [];
  const load = vi.spyOn(local, 'loadHarnessUpdates');
  await showMachines();
  expect(load).toHaveBeenCalledExactlyOnceWith(true);
  local.connection = 'closed'; await settle();
  const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="harness-updates-card"] button:not(.info-tip)')];
  expect(actions.length).toBeGreaterThan(2);
  expect(actions.every(button => button.disabled)).toBe(true);
  expect(document.querySelector<HTMLInputElement>('[data-testid="setting-auto-update-harnesses"]')!.disabled).toBe(true);
  local.principal = 'session'; await settle();
  expect(document.querySelector('[data-testid="harness-updates-card"]')).toBeNull();
});
