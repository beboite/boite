import { expect, test, vi } from 'vitest';
import type { AppUpdateBackend, UpdateChannel, UpdateClock, UpdateSnapshot } from './app-update.svelte';
import { AppUpdater, appName, appUpdater } from './app-update.svelte';

function snapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'current',
    currentVersion: '2.0.0',
    currentChannel: 'stable',
    channel: 'stable',
    version: null,
    notes: null,
    publishedAt: null,
    received: 0,
    total: null,
    error: null,
    supported: true,
    ...overrides
  };
}

function backend(overrides: Partial<AppUpdateBackend> = {}): AppUpdateBackend {
  return {
    status: vi.fn(async () => snapshot()),
    check: vi.fn(async (channel) => snapshot({ channel })),
    download: vi.fn(async () => snapshot({ phase: 'ready', version: '2.1.0' })),
    install: vi.fn(async () => undefined),
    listen: vi.fn(async () => () => undefined),
    ...overrides
  };
}

test('a dismissed offer stays installable and a different version or channel is announced', () => {
  const updater = new AppUpdater();
  updater.snapshot = snapshot({ phase: 'ready', version: '2.1.0' });
  try {
    updater.dismiss();
    expect(updater.announceReady).toBe(false);
    expect(updater.ready).toBe(true);
    updater.snapshot = snapshot({ phase: 'checking' });
    updater.snapshot = snapshot({ phase: 'ready', version: '2.1.0' });
    expect(updater.announceReady).toBe(false);
    updater.snapshot = { ...updater.snapshot, version: '2.2.0' };
    expect(updater.announceReady).toBe(true);
    updater.snapshot = { ...updater.snapshot, version: '2.1.0', channel: 'nightly' };
    expect(updater.announceReady).toBe(true);
  } finally {
    window.localStorage.removeItem('boite.app-update-dismissed');
  }
});

class FakeClock implements UpdateClock {
  next = 1;
  timeouts = new Map<number, () => void>();
  intervals = new Map<number, () => void>();
  clearedTimeouts: number[] = [];
  clearedIntervals: number[] = [];

  setTimeout(callback: () => void): unknown {
    const id = this.next++;
    this.timeouts.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    const id = handle as number;
    this.clearedTimeouts.push(id);
    this.timeouts.delete(id);
  }

  setInterval(callback: () => void): unknown {
    const id = this.next++;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    const id = handle as number;
    this.clearedIntervals.push(id);
    this.intervals.delete(id);
  }

  runTimeouts(): void {
    const callbacks = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const callback of callbacks) callback();
  }
}

test('serializes checks, keeps the latest channel, announces it at once and downloads it once asked', async () => {
  let releaseStable!: (value: UpdateSnapshot) => void;
  const stable = new Promise<UpdateSnapshot>((resolve) => { releaseStable = resolve; });
  let checkedChannel: UpdateChannel = 'stable';
  const native = backend({
    check: vi.fn(async (channel) => {
      checkedChannel = channel;
      if (channel === 'stable') return stable;
      return snapshot({ phase: 'available', channel, version: '2.1.0-nightly.4' });
    }),
    download: vi.fn(async () => snapshot({
      phase: 'ready',
      channel: checkedChannel,
      version: checkedChannel === 'nightly' ? '2.1.0-nightly.4' : '2.1.0'
    }))
  });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  const stop = updater.start();
  await updater.settled();

  updater.check('stable');
  await Promise.resolve();
  updater.check('nightly');
  releaseStable(snapshot({ phase: 'available', channel: 'stable', version: '2.1.0' }));
  await updater.settled();

  expect(vi.mocked(native.check).mock.calls.map(([channel]) => channel)).toEqual(['stable', 'nightly']);
  // Found is shown: nothing downloads before the user asks, so the offer appears without waiting for one.
  expect(native.download).not.toHaveBeenCalled();
  expect(updater.snapshot).toMatchObject({ phase: 'available', channel: 'nightly', version: '2.1.0-nightly.4' });
  expect(updater.hasUpdate).toBe(true);

  expect(await updater.prepare()).toBe(true);
  expect(await updater.prepare()).toBe(true);
  expect(native.download).toHaveBeenCalledTimes(1);
  expect(updater.snapshot).toMatchObject({ phase: 'ready', channel: 'nightly', version: '2.1.0-nightly.4' });
  stop();
});

test('allows restoring an older stable release from installed nightly', async () => {
  const native = backend({
    status: vi.fn(async () => snapshot({
      currentVersion: '2.1.0-nightly.8',
      currentChannel: 'nightly',
      channel: 'nightly'
    })),
    check: vi.fn(async (channel) => snapshot({
      phase: 'available',
      currentVersion: '2.1.0-nightly.8',
      currentChannel: 'nightly',
      channel,
      version: '2.0.0'
    })),
    download: vi.fn(async () => snapshot({
      phase: 'ready',
      currentVersion: '2.1.0-nightly.8',
      currentChannel: 'nightly',
      channel: 'stable',
      version: '2.0.0'
    }))
  });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  const stop = updater.start();
  await updater.settled();
  updater.check('stable');
  await updater.settled();
  updater.download();
  await updater.settled();

  expect(native.check).toHaveBeenCalledWith('stable');
  expect(native.download).toHaveBeenCalledOnce();
  expect(updater.snapshot).toMatchObject({
    phase: 'ready',
    currentVersion: '2.1.0-nightly.8',
    currentChannel: 'nightly',
    channel: 'stable',
    version: '2.0.0'
  });
  stop();
});

test('does nothing outside the desktop shell', () => {
  const clock = new FakeClock();
  const native = backend();
  const updater = new AppUpdater(native, clock, () => false);

  const stop = updater.start();

  expect(native.status).not.toHaveBeenCalled();
  expect(native.listen).not.toHaveBeenCalled();
  expect(clock.timeouts.size).toBe(0);
  expect(clock.intervals.size).toBe(0);
  stop();
});

test('unlistens when listener setup finishes after stop', async () => {
  let finishListen!: (unlisten: () => void) => void;
  const listening = new Promise<() => void>((resolve) => { finishListen = resolve; });
  const unlisten = vi.fn();
  const native = backend({ listen: vi.fn(async () => listening) });
  const updater = new AppUpdater(native, new FakeClock(), () => true);

  const stop = updater.start();
  stop();
  finishListen(unlisten);
  await listening;
  await Promise.resolve();

  expect(unlisten).toHaveBeenCalledOnce();
});

test('keeps native error snapshots and does not start a download', async () => {
  const native = backend({
    check: vi.fn(async () => snapshot({ phase: 'error', error: 'signature metadata is missing' }))
  });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  const stop = updater.start();
  await updater.settled();
  updater.check('stable');
  await updater.settled();

  expect(updater.snapshot).toMatchObject({ phase: 'error', error: 'signature metadata is missing' });
  expect(native.download).not.toHaveBeenCalled();
  stop();
});

test('keeps a download error snapshot returned by the native command', async () => {
  const native = backend({
    check: vi.fn(async () => snapshot({ phase: 'available', version: '2.1.0' })),
    download: vi.fn(async () => snapshot({ phase: 'error', version: '2.1.0', error: 'signature verification failed' }))
  });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  const stop = updater.start();
  await updater.settled();
  updater.check('stable');
  await updater.settled();
  expect(await updater.prepare()).toBe(false);

  expect(native.download).toHaveBeenCalledOnce();
  expect(updater.snapshot).toMatchObject({ phase: 'error', error: 'signature verification failed' });
  // Asked again after a failure, it checks again before downloading again.
  expect(await updater.prepare()).toBe(false);
  expect(native.check).toHaveBeenCalledTimes(2);
  expect(native.download).toHaveBeenCalledTimes(2);
  stop();
});

test('shows an invocation rejection as a supported updater error', async () => {
  const native = backend({
    check: vi.fn(async () => { throw new Error('request already running'); })
  });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  const stop = updater.start();
  await updater.settled();
  updater.check('stable');
  await updater.settled();

  expect(updater.snapshot).toMatchObject({ phase: 'error', error: 'request already running', supported: true });
  stop();
});

test('cleans up its listener and timers and stops scheduled checks when ready', async () => {
  const clock = new FakeClock();
  const unlisten = vi.fn();
  const native = backend({
    status: vi.fn(async () => snapshot({ phase: 'ready', version: '2.1.0' })),
    listen: vi.fn(async () => unlisten)
  });
  const updater = new AppUpdater(native, clock, () => true);
  const stop = updater.start();
  await updater.settled();
  await Promise.resolve();

  clock.runTimeouts();
  expect(native.check).not.toHaveBeenCalled();
  expect(clock.intervals.size).toBe(1);

  stop();
  expect(unlisten).toHaveBeenCalledOnce();
  expect(clock.intervals.size).toBe(0);
  expect(clock.clearedIntervals).toHaveLength(1);
});

test('a nightly build calls itself boite (de nuit)', () => {
  const before = appUpdater.snapshot;
  try {
    expect(appName()).toBe('Boite');
    appUpdater.snapshot = snapshot({ currentVersion: '2.1.0-nightly.8', currentChannel: 'nightly' });
    expect(appName()).toBe('boite (de nuit)');
  } finally {
    appUpdater.snapshot = before;
  }
});

test('waiting blocks checks and cancels without waiting for the install invocation', async () => {
  const ready = snapshot({ phase: 'ready', version: '2.1.0' });
  let publish!: (value: UpdateSnapshot) => void;
  let finish!: () => void;
  let confirmCancel!: (value: boolean) => void;
  const native = backend({
    status: vi.fn(async () => ready),
    listen: vi.fn(async (handler) => { publish = handler; return () => undefined; }),
    install: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
    cancelInstall: vi.fn(() => new Promise<boolean>((resolve) => { confirmCancel = resolve; }))
  });
  const clock = new FakeClock();
  const updater = new AppUpdater(native, clock, () => true);
  const stop = updater.start();
  await updater.settled();
  updater.install();
  expect(updater.snapshot.phase).toBe('waiting');
  expect(updater.busy).toBe(true);
  updater.check('nightly');
  clock.runTimeouts();
  const cancelled = updater.cancelInstall();
  expect(native.cancelInstall).toHaveBeenCalledOnce();
  expect(updater.snapshot.phase).toBe('waiting');
  confirmCancel(true);
  expect(await cancelled).toBe(true);
  expect(updater.snapshot.phase).toBe('waiting');
  publish(ready);
  finish();
  await updater.settled();
  expect(updater.snapshot).toEqual(ready);
  expect(native.check).not.toHaveBeenCalled();
  stop();
});

test('a cancellation rejected after idle admission cannot restore ready', async () => {
  let finishCancel!: (value: boolean) => void;
  const native = backend({ cancelInstall: vi.fn(() => new Promise<boolean>((resolve) => { finishCancel = resolve; })) });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  updater.snapshot = snapshot({ phase: 'waiting', version: '2.1.0' });
  const cancelled = updater.cancelInstall();
  updater.snapshot = { ...updater.snapshot, phase: 'installing' };
  finishCancel(false);
  expect(await cancelled).toBe(false);
  expect(updater.snapshot.phase).toBe('installing');
  expect(await updater.cancelInstall()).toBe(false);
  expect(native.cancelInstall).toHaveBeenCalledOnce();
});

test('native waiting discards a channel selection queued behind startup status', async () => {
  let publish!: (value: UpdateSnapshot) => void;
  let finishStatus!: (value: UpdateSnapshot) => void;
  const ready = snapshot({ phase: 'ready', version: '2.1.0' });
  const native = backend({
    status: vi.fn(() => new Promise<UpdateSnapshot>((resolve) => { finishStatus = resolve; })),
    listen: vi.fn(async (handler) => { publish = handler; return () => undefined; })
  });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  const stop = updater.start();
  publish(ready);
  updater.check('nightly');
  const waiting = { ...ready, phase: 'waiting' as const };
  publish(waiting);
  finishStatus(waiting);
  await updater.settled();
  publish(ready);
  await updater.settled();
  expect(native.check).not.toHaveBeenCalled();
  expect(updater.snapshot.channel).toBe('stable');
  stop();
});

test('a failed cancellation keeps installation waiting and reports the error', async () => {
  const native = backend({ cancelInstall: vi.fn(async () => { throw new Error('native request failed'); }) });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  updater.snapshot = snapshot({ phase: 'waiting', version: '2.1.0' });
  expect(await updater.cancelInstall()).toBe(false);
  expect(updater.snapshot).toMatchObject({ phase: 'waiting', error: 'native request failed' });
  expect(updater.cancelling).toBe(false);
  expect(updater.busy).toBe(true);
});

test('a release another machine asks for installs without a dialog, and only the release this window offers', async () => {
  const native = backend({ check: vi.fn(async () => snapshot({ phase: 'available', version: '2.1.0' })) });
  const updater = new AppUpdater(native, new FakeClock(), () => true);
  const stop = updater.start();
  await updater.settled();
  updater.check('stable');
  await updater.settled();

  // A stale request names another release: nothing downloads or installs.
  expect(await updater.installRequested('2.0.9')).toBe(false);
  expect(native.download).not.toHaveBeenCalled();

  expect(await updater.installRequested('2.1.0')).toBe(true);
  expect(native.download).toHaveBeenCalledOnce();
  await updater.settled();
  expect(native.install).toHaveBeenCalledOnce();
  stop();
});

test('with autoInstallUpdates, the timer downloads the release it found and installs it quietly, and a busy machine waits for the next tick', async () => {
  const clock = new FakeClock();
  let busy = true;
  const native = backend({
    check: vi.fn(async (channel) => snapshot({ phase: 'available', channel, version: '2.1.0' })),
    download: vi.fn(async () => snapshot({ phase: 'ready', version: '2.1.0' })),
    installQuietly: vi.fn(async () => !busy)
  });
  const updater = new AppUpdater(native, clock, () => true);
  updater.autoInstall = true;
  const stop = updater.start();
  await updater.settled();

  // The first tick checks, downloads and asks; the shell answers that it is not the moment.
  clock.runTimeouts();
  await vi.waitFor(() => expect(native.installQuietly).toHaveBeenCalledTimes(1));
  expect(native.check).toHaveBeenCalledTimes(1);
  expect(native.download).toHaveBeenCalledTimes(1);
  expect(native.install).not.toHaveBeenCalled();
  expect(updater.snapshot.phase).toBe('ready');

  // The next tick tries the ready release again without checking or downloading it anew.
  busy = false;
  [...clock.intervals.values()][0]!();
  await vi.waitFor(() => expect(native.installQuietly).toHaveBeenCalledTimes(2));
  expect(native.check).toHaveBeenCalledTimes(1);
  expect(native.download).toHaveBeenCalledTimes(1);
  expect(native.install).not.toHaveBeenCalled();
  stop();
});

test('without autoInstallUpdates, a release found by the timer only waits to be asked for', async () => {
  const clock = new FakeClock();
  const native = backend({
    check: vi.fn(async (channel) => snapshot({ phase: 'available', channel, version: '2.1.0' })),
    installQuietly: vi.fn(async () => true)
  });
  const updater = new AppUpdater(native, clock, () => true);
  const stop = updater.start();
  await updater.settled();
  clock.runTimeouts();
  await updater.settled();
  expect(updater.snapshot.phase).toBe('available');
  expect(await updater.installByItself()).toBe(false);
  expect(native.download).not.toHaveBeenCalled();
  expect(native.installQuietly).not.toHaveBeenCalled();
  stop();
});
