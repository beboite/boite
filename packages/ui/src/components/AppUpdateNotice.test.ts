import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AppUpdateNotice from './AppUpdateNotice.svelte';
import { appUpdater } from '../lib/app-update.svelte';

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
  document.body.innerHTML = '';
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
