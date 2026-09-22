import { expect, test, vi } from 'vitest';
import type { AppUpdateBackend, UpdateChannel, UpdateClock, UpdateSnapshot } from './app-update.svelte';
import { AppUpdater } from './app-update.svelte';

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

test('serializes checks, keeps the latest channel, then downloads it once', async () => {
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

  expect(native.download).toHaveBeenCalledOnce();
  expect(updater.snapshot).toMatchObject({ phase: 'error', error: 'signature verification failed' });
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
