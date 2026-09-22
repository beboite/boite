import { afterEach, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import { AppUpdater, type AppUpdateBackend, type UpdateSnapshot } from './app-update.svelte';
import { AppUpdateInstall } from './app-update-install.svelte';
import { confirm } from './confirm.svelte';

const ready: UpdateSnapshot = {
  phase: 'ready',
  currentVersion: '2.0.0',
  currentChannel: 'stable',
  channel: 'nightly',
  version: '2.1.0-nightly.8',
  notes: null,
  publishedAt: null,
  received: 100,
  total: 100,
  error: null,
  supported: true
};

function setup() {
  let publish!: (snapshot: UpdateSnapshot) => void;
  const backend: AppUpdateBackend = {
    status: vi.fn(async () => ready),
    check: vi.fn(async () => ready),
    download: vi.fn(async () => ready),
    install: vi.fn(async () => undefined),
    listen: vi.fn(async (handler) => {
      publish = handler;
      return () => undefined;
    })
  };
  const updater = new AppUpdater(backend, undefined, () => true);
  const stop = updater.start();
  return { backend, updater, publish: (snapshot: UpdateSnapshot) => publish(snapshot), stop };
}

afterEach(() => confirm.answer(false));

test('one pending confirmation locks every install entry point and cancel leaves the update ready', async () => {
  const { backend, updater, stop } = setup();
  await updater.settled();
  await Promise.resolve();
  const install = new AppUpdateInstall();

  const first = install.request(updater);
  flushSync();
  expect(install.preparing).toBe(true);
  await expect(install.request(updater)).resolves.toBe(false);
  confirm.answer(false);
  await expect(first).resolves.toBe(false);
  expect(install.preparing).toBe(false);
  expect(backend.install).not.toHaveBeenCalled();
  stop();
});

test('a confirmed update installs only while its ready version and channel are unchanged', async () => {
  const { backend, updater, publish, stop } = setup();
  await updater.settled();
  await Promise.resolve();
  const install = new AppUpdateInstall();

  const stale = install.request(updater);
  publish({ ...ready, channel: 'stable', version: '2.0.0' });
  flushSync();
  confirm.answer(true);
  await expect(stale).resolves.toBe(false);
  expect(backend.install).not.toHaveBeenCalled();

  publish(ready);
  flushSync();
  const current = install.request(updater);
  confirm.answer(true);
  await expect(current).resolves.toBe(true);
  expect(backend.install).toHaveBeenCalledOnce();
  stop();
});
