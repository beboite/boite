/**
 * The guard's main-thread half against a fake Worker: when one is built, told
 * the pids, stopped when idle, and what a refusal does to it. Nothing native.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  guardPidAdded,
  guardPidRemoved,
  guardStatus,
  releaseGuard,
  retainGuard,
  setGuardEnabled,
  setGuardMute,
  setGuardWorkerForTests,
  warmGuard,
} from '../src/platform/windows/guard.ts';
import type { GuardWorkerHandle } from '../src/platform/windows/guard.ts';
import type { GuardWorkerCommand, GuardWorkerMessage } from '../src/platform/windows/guard-worker.ts';
import { waitFor } from './harness.ts';

const IDLE_MS = 20;

class FakeWorker implements GuardWorkerHandle {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: GuardWorkerCommand[] = [];
  terminated = false;
  /** Answer 'stopped' on its own once the stop flag is up, as the pump does. */
  answersStop = true;

  postMessage(message: GuardWorkerCommand): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: GuardWorkerMessage): void {
    this.onmessage?.({ data: message });
  }

  stopAsked(): boolean {
    const start = this.posted.find((command) => command.kind === 'start');
    if (start?.kind !== 'start') return false;
    return Atomics.load(new Int32Array(start.stop), 0) === 1;
  }

  pidsAdded(): number[] {
    return this.posted.flatMap((command) => (command.kind === 'pid-add' ? [command.pid] : []));
  }
}

describe('the guard Worker lifecycle', () => {
  let workers: FakeWorker[];
  let notes: string[];
  let muted: number[];
  let pump: ReturnType<typeof setInterval>;

  beforeEach(() => {
    workers = [];
    notes = [];
    muted = [];
    setGuardWorkerForTests(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, IDLE_MS);
    retainGuard({
      pushed: () => undefined,
      muted: (_threadId, pid) => muted.push(pid),
      note: (message) => notes.push(message),
    });
    setGuardEnabled(true);
    setGuardMute(true);
    // Every fake that was asked to stop answers the way the real pump does.
    pump = setInterval(() => {
      for (const worker of workers) {
        if (worker.answersStop && !worker.terminated && worker.stopAsked()) worker.emit({ kind: 'stopped' });
      }
    }, 2);
  });

  afterEach(async () => {
    await releaseGuard();
    clearInterval(pump);
    setGuardWorkerForTests(null);
    setGuardEnabled(true);
    setGuardMute(true);
  });

  test('a refused focus hook keeps the Worker, and the audio mute with it', () => {
    guardPidAdded('thr_one', 11);
    const worker = workers[0] as FakeWorker;
    worker.emit({ kind: 'hook-failed', reason: 'SetWinEventHook returned no hook' });

    const status = guardStatus();
    expect(status.running).toBe(true);
    expect(status.failure).toBe('SetWinEventHook returned no hook');
    expect(worker.terminated).toBe(false);

    guardPidAdded('thr_one', 12);
    expect(worker.pidsAdded()).toEqual([11, 12]);
    worker.emit({ kind: 'session-muted', threadId: 'thr_one', pid: 12 });
    expect(guardStatus().mutedPids).toEqual([12]);
    expect(muted).toEqual([12]);
    expect(workers).toHaveLength(1);
  });

  test('a Worker that cannot run is terminated, not dropped, and never rebuilt', () => {
    guardPidAdded('thr_one', 11);
    const worker = workers[0] as FakeWorker;
    worker.emit({ kind: 'failed', reason: 'user32.dll is missing' });

    expect(worker.terminated).toBe(true);
    expect(guardStatus()).toMatchObject({ running: false, failure: 'user32.dll is missing' });
    guardPidAdded('thr_one', 12);
    expect(workers).toHaveLength(1);
    expect(notes).toEqual(['the focus guard is off: user32.dll is missing']);
  });

  test('a Worker that errors after its hook went in unhooks before it is terminated', async () => {
    guardPidAdded('thr_one', 11);
    const worker = workers[0] as FakeWorker;
    worker.answersStop = false;
    worker.emit({ kind: 'ready', hook: '4242' });
    worker.onerror?.({ message: 'boom' });

    expect(worker.stopAsked()).toBe(true);
    expect(worker.terminated).toBe(false);
    worker.emit({ kind: 'stopped' });
    expect(worker.terminated).toBe(true);
    expect(guardStatus().running).toBe(false);
  });

  test('the Worker stops once nothing traced has run for a while, and comes back with the next pid', async () => {
    guardPidAdded('thr_one', 11);
    const first = workers[0] as FakeWorker;
    guardPidAdded('thr_one', 12);
    guardPidRemoved('thr_one', 11);
    // One pid still runs: nothing stops.
    await Bun.sleep(IDLE_MS * 3);
    expect(first.stopAsked()).toBe(false);

    guardPidRemoved('thr_one', 12);
    await waitFor(() => first.terminated, 1000);
    expect(guardStatus().running).toBe(false);

    guardPidAdded('thr_two', 13);
    expect(workers).toHaveLength(2);
    const second = workers[1] as FakeWorker;
    expect(second.posted[0]?.kind).toBe('start');
    expect(second.pidsAdded()).toEqual([13]);
    expect(guardStatus().running).toBe(true);
  });

  test('a pid that comes inside the idle delay keeps the same Worker', async () => {
    guardPidAdded('thr_one', 11);
    guardPidRemoved('thr_one', 11);
    guardPidAdded('thr_one', 12);
    await Bun.sleep(IDLE_MS * 3);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.stopAsked()).toBe(false);
  });

  test('with both protections off no Worker is built, and one comes with the switch, told every pid', async () => {
    setGuardEnabled(false);
    setGuardMute(false);
    guardPidAdded('thr_one', 11);
    expect(workers).toHaveLength(0);
    expect(guardStatus().running).toBe(false);

    setGuardMute(true);
    expect(workers).toHaveLength(1);
    const worker = workers[0] as FakeWorker;
    expect(worker.posted[0]).toMatchObject({ kind: 'start', enabled: false, mute: true });
    expect(worker.pidsAdded()).toEqual([11]);
  });

  test('turning both protections off stops a running Worker', async () => {
    guardPidAdded('thr_one', 11);
    const worker = workers[0] as FakeWorker;
    setGuardEnabled(false);
    setGuardMute(false);
    await waitFor(() => worker.terminated, 1000);
    expect(guardStatus().running).toBe(false);
  });

  test('a warm guard with no pid still goes idle', async () => {
    warmGuard();
    expect(workers).toHaveLength(1);
    await waitFor(() => (workers[0] as FakeWorker).terminated, 1000);
  });

  test('the release resolves only once the Worker said it stopped', async () => {
    guardPidAdded('thr_one', 11);
    const worker = workers[0] as FakeWorker;
    worker.answersStop = false;
    let released = false;
    const release = releaseGuard().then(() => {
      released = true;
    });
    await Bun.sleep(20);
    expect(released).toBe(false);
    expect(worker.stopAsked()).toBe(true);
    worker.emit({ kind: 'stopped' });
    await release;
    expect(worker.terminated).toBe(true);
    // afterEach releases once more; take the reference that one gives back.
    retainGuard({ pushed: () => undefined, muted: () => undefined, note: () => undefined });
  });
});
