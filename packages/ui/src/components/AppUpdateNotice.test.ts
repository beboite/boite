import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AppUpdateNotice from './AppUpdateNotice.svelte';
import { appUpdater } from '../lib/app-update.svelte';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';

vi.mock('../lib/app-update.svelte', async (original) => ({
  ...await original<typeof import('../lib/app-update.svelte')>(),
  showAppUpdateUi: () => true
}));

let view: ReturnType<typeof mount> | undefined;
const initial = { ...appUpdater.snapshot };
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  appUpdater.snapshot = { ...initial };
  workspace.machines = [];
  workspace.active = primary;
  document.body.innerHTML = '';
});

test('the shortcut opens Machines directly without switching the selected core or creating a popup', () => {
  const active = new Store();
  const remote = new Store();
  active.principal = 'owner'; remote.principal = 'owner';
  workspace.machines = [{ id: 'active', label: 'Active', store: active }, { id: 'remote', label: 'Builder', store: remote }];
  workspace.active = active;
  remote.serverUpdater.apply({ phase: 'available', mode: 'systemd', currentVersion: '2.0.0', version: '2.1.0', channel: 'stable', received: 0, total: null, checkedAt: 1, publishedAt: null, error: null });
  view = mount(AppUpdateNotice, { target: document.body }); flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid=nav-app-update]')!.click();
  expect(active.page).toBe('settings');
  expect(active.settingsTab).toBe('machines');
  expect(active.settingsSection?.id).toBe('updates');
  expect(workspace.active).toBe(active);
  expect(document.querySelector('[data-testid=app-update-popover]')).toBeNull();
});

test('the footer shows an update only when one is offered, including a download and a pending restart', () => {
  appUpdater.snapshot = { ...initial, supported: true, phase: 'current' };
  view = mount(AppUpdateNotice, { target: document.body });
  expect(document.querySelector('[data-testid=nav-app-update]')).toBeNull();
  for (const phase of ['available', 'downloading', 'ready', 'waiting', 'installing'] as const) {
    appUpdater.snapshot = { ...appUpdater.snapshot, version: '2.1.0', phase };
    flushSync();
    expect(document.querySelector('[data-testid=nav-app-update]')).not.toBeNull();
  }
  appUpdater.snapshot = { ...appUpdater.snapshot, phase: 'error', version: null, error: 'Offline' };
  flushSync();
  expect(document.querySelector('[data-testid=nav-app-update]')).toBeNull();
});
