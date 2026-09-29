import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AppUpdateContent from './AppUpdateContent.svelte';
import { AppUpdater, type AppUpdateBackend, type UpdateSnapshot } from '../lib/app-update.svelte';
import { confirm } from '../lib/confirm.svelte';

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted, { outro: false });
  mounted = null;
  document.body.innerHTML = '';
  confirm.answer(false);
});

test('shows the release link, age, installed channel and ready action', async () => {
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

  mounted = mount(AppUpdateContent, { target: document.body, props: { updater, beforeInstall: () => undefined } });
  const text = document.body.textContent ?? '';
  expect(text).toContain('Installed version: Boite 2.0.0');
  expect(text).toContain('Boite');
  expect(text).toContain('Boite Nightly');
  expect(text).toContain('2.0.0-nightly.8');
  expect(text).not.toContain('Update downloads resume correctly');
  expect(document.querySelector<HTMLAnchorElement>('[data-testid=app-update-changelog]')?.href).toBe('https://github.com/beboite/boite/releases/tag/v2.0.0-nightly.8');
  expect(document.querySelector('[data-testid=app-update-published]')?.textContent).toContain('Released');
  expect(document.querySelector('[data-testid=app-update-install]')).not.toBeNull();
  stop();
});

test('the check button stays in the popup, disabled, while a check runs', async () => {
  const current: UpdateSnapshot = {
    phase: 'current',
    currentVersion: '2.0.0-nightly.7',
    currentChannel: 'nightly',
    channel: 'nightly',
    version: null,
    notes: null,
    publishedAt: null,
    received: 0,
    total: null,
    error: null,
    supported: true
  };
  let publish!: (snapshot: UpdateSnapshot) => void;
  let finish!: (snapshot: UpdateSnapshot) => void;
  const native: AppUpdateBackend = {
    status: vi.fn(async () => current),
    // The shell announces the check before it answers, as the native command does.
    check: vi.fn(() => {
      publish({ ...current, phase: 'checking' });
      return new Promise<UpdateSnapshot>((resolve) => { finish = resolve; });
    }),
    download: vi.fn(async () => current),
    install: vi.fn(async () => undefined),
    listen: vi.fn(async (handler) => {
      publish = handler;
      return () => undefined;
    })
  };
  const updater = new AppUpdater(native, undefined, () => true);
  const stop = updater.start();
  await updater.settled();
  mounted = mount(AppUpdateContent, { target: document.body, props: { updater, beforeInstall: () => undefined } });
  const button = () => document.querySelector<HTMLButtonElement>('[data-testid=app-update-check]');

  expect(button()?.disabled).toBe(false);
  button()!.click();
  flushSync();
  expect(button()?.disabled).toBe(true);
  expect(button()?.getAttribute('aria-busy')).toBe('true');
  expect(button()?.textContent).toContain('Checking');

  finish({ ...current, phase: 'current' });
  await updater.settled();
  flushSync();
  expect(button()?.disabled).toBe(false);
  expect(native.check).toHaveBeenCalledOnce();
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
  mounted = mount(AppUpdateContent, { target: document.body, props: { updater, beforeInstall: () => undefined } });

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

test('waiting offers cancellation and locks the channel until native confirms ready', async () => {
  const ready: UpdateSnapshot = {
    phase: 'ready', currentVersion: '2.0.0', currentChannel: 'stable', channel: 'nightly',
    version: '2.1.0-nightly.8', notes: null, publishedAt: null, received: 100, total: 100,
    error: null, supported: true
  };
  let publish!: (snapshot: UpdateSnapshot) => void;
  let finishCancel!: (accepted: boolean) => void;
  const native: AppUpdateBackend = {
    status: vi.fn(async (): Promise<UpdateSnapshot> => ({ ...ready, phase: 'waiting' })),
    check: vi.fn(async () => ready), download: vi.fn(async () => ready),
    install: vi.fn(async () => undefined),
    cancelInstall: vi.fn(() => new Promise<boolean>((resolve) => { finishCancel = resolve; })),
    listen: vi.fn(async (handler) => { publish = handler; return () => undefined; })
  };
  const updater = new AppUpdater(native, undefined, () => true);
  const stop = updater.start();
  await updater.settled();
  mounted = mount(AppUpdateContent, { target: document.body, props: { updater, beforeInstall: () => undefined } });
  expect(document.querySelector('[data-testid=app-update-status]')?.textContent).toContain('Waiting for work');
  expect(document.querySelector('[data-testid=app-update-check]')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-testid=app-update-stable]')?.disabled).toBe(true);
  const cancel = document.querySelector<HTMLButtonElement>('[data-testid=app-update-cancel]')!;
  cancel.click();
  flushSync();
  expect(cancel.disabled).toBe(true);
  cancel.click();
  expect(native.cancelInstall).toHaveBeenCalledOnce();
  finishCancel(true);
  await Promise.resolve();
  flushSync();
  expect(document.querySelector('[data-testid=app-update-install]')).toBeNull();
  publish(ready);
  flushSync();
  expect(document.querySelector('[data-testid=app-update-cancel]')).toBeNull();
  expect(document.querySelector('[data-testid=app-update-install]')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-testid=app-update-stable]')?.disabled).toBe(false);
  stop();
});
