import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AppUpdateCard from './AppUpdateCard.svelte';
import { AppUpdater, type AppUpdateBackend, type UpdateSnapshot } from '../lib/app-update.svelte';
import { confirm } from '../lib/confirm.svelte';

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted, { outro: false });
  mounted = null;
  document.body.innerHTML = '';
  confirm.answer(false);
});

test('shows channel mismatch, versions, safe release notes and the ready action', async () => {
  const ready: UpdateSnapshot = {
    phase: 'ready',
    currentVersion: '2.0.0',
    currentChannel: 'stable',
    channel: 'nightly',
    version: '2.0.0-nightly.8',
    notes: '## Fixed\n\n- Update downloads resume correctly',
    publishedAt: '2026-09-22T12:00:00Z',
    received: 100,
    total: 100,
    error: null,
    supported: true
  };
  const native: AppUpdateBackend = {
    status: vi.fn(async () => ready),
    check: vi.fn(async () => ready),
    download: vi.fn(async () => ready),
    install: vi.fn(async () => undefined),
    listen: vi.fn(async () => () => undefined)
  };
  const updater = new AppUpdater(native, undefined, () => true);
  const stop = updater.start();
  await updater.settled();

  mounted = mount(AppUpdateCard, { target: document.body, props: { updater } });
  const text = document.body.textContent ?? '';
  expect(text).toContain('Installed channel');
  expect(text).toContain('Boite');
  expect(text).toContain('Boite Nightly');
  expect(text).toContain('2.0.0-nightly.8');
  expect(text).toContain('Update downloads resume correctly');
  expect(document.querySelector('[data-testid=app-update-install]')).not.toBeNull();
  stop();
});

test('prevents duplicate install dialogs and refuses a stale confirmed selection', async () => {
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
  let publish!: (snapshot: UpdateSnapshot) => void;
  const native: AppUpdateBackend = {
    status: vi.fn(async () => ready),
    check: vi.fn(async () => ready),
    download: vi.fn(async () => ready),
    install: vi.fn(async () => undefined),
    listen: vi.fn(async (handler) => {
      publish = handler;
      return () => undefined;
    })
  };
  const updater = new AppUpdater(native, undefined, () => true);
  const stop = updater.start();
  await updater.settled();
  await Promise.resolve();
  mounted = mount(AppUpdateCard, { target: document.body, props: { updater } });

  const ask = vi.spyOn(confirm, 'ask');
  const button = document.querySelector<HTMLButtonElement>('[data-testid=app-update-install]')!;
  button.click();
  flushSync();
  expect(button.disabled).toBe(true);
  button.click();
  expect(ask).toHaveBeenCalledOnce();

  publish({ ...ready, channel: 'stable', version: '2.0.0' });
  flushSync();
  confirm.answer(true);
  await Promise.resolve();
  expect(native.install).not.toHaveBeenCalled();

  ask.mockRestore();
  stop();
});
