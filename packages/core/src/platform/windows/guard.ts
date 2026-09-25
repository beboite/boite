/**
 * The focus guard's main-thread half, and the audio mute's: it holds the pid set
 * the Worker filters on, forwards both settings, and turns what the Worker
 * pushed back into events.
 *
 * Nothing native happens here. The Worker is built on the first traced pid, the
 * same way the Job Object one is, so a core that never launches a process never
 * pays for a Worker, a `user32.dll` handle, a system-wide hook or a COM
 * apartment. It is stopped again once nothing traced has run for a while, or
 * once both protections are off, so an idle core does not keep a pump waking
 * ten times a second. Other operating systems use the separate POSIX backend.
 */
import { workerEntry } from './worker-entry.ts';
import type { GuardWorkerCommand, GuardWorkerMessage } from './guard-worker.ts';

import type { GuardEventSink, GuardStatus } from '../types.ts';

/** One bounded wait on the message queue before the stop flag is read again. */
const WAIT_MS = 100;
/**
 * How long the Worker outlives the last traced pid. Back-to-back turns keep the
 * same Worker and the same hook; a turn that starts later warms a new one first.
 */
const IDLE_STOP_MS = 30_000;

/** What the module needs of a Worker, so a test can hand it a fake. */
export interface GuardWorkerHandle {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage(message: GuardWorkerCommand): void;
  terminate(): void;
  unref?: () => void;
}

const nativeWorker = (): GuardWorkerHandle =>
  new Worker(workerEntry(import.meta.url, 'guard-worker')) as unknown as GuardWorkerHandle;

let createWorker: () => GuardWorkerHandle = nativeWorker;
let idleStopMs = IDLE_STOP_MS;

let refCount = 0;
let sink: GuardEventSink | null = null;
let worker: GuardWorkerHandle | null = null;
let stopFlag: Int32Array | null = null;
let hook: string | null = null;
/** The Worker could not run at all. No new one is built until the core's teardown. */
let failure: string | null = null;
/** Only the focus hook was refused; the Worker keeps muting. */
let hookFailure: string | null = null;
let enabled = true;
let muteEnabled = true;
let audioFailure: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Every traced pid still running, with its thread: what a new Worker is told. */
const pids = new Map<number, string>();
/** The pids the Worker said it muted, minus the ones that have since exited. */
const mutedPids = new Set<number>();
/** Workers on their way out: each unhooks and unmutes before it is terminated. */
const stopping = new Set<Promise<void>>();

export function retainGuard(events: GuardEventSink): void {
  refCount += 1;
  sink = events;
}

/**
 * Resolves once the Worker has unhooked and given every muted session its
 * sound back, or after the one-second fallback. A core that exits before that
 * leaves those sessions muted for good: Windows keeps the mute for the next run
 * of the same executable.
 */
export function releaseGuard(): Promise<void> {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return Promise.resolve();
  sink = null;
  return teardown();
}

export function setGuardEnabled(next: boolean): void {
  enabled = next;
  post({ kind: 'set', enabled: next, mute: muteEnabled });
  settingsChanged();
}

export function setGuardMute(next: boolean): void {
  muteEnabled = next;
  // The Worker unmutes everything it holds when it is turned off, so nothing is
  // left muted behind a switch the user just moved.
  if (!next) mutedPids.clear();
  post({ kind: 'set', enabled, mute: next });
  settingsChanged();
}

/** A turn is starting: have the hook in before its first process can open a window. */
export function warmGuard(): void {
  if (!wanted()) return;
  ensureWorker();
  if (pids.size === 0) armIdleStop();
}

export function guardPidAdded(threadId: string, pid: number): void {
  if (pid <= 0) return;
  pids.set(pid, threadId);
  cancelIdleStop();
  // A Worker built here is told every pid, this one included.
  if (ensureWorker()) return;
  post({ kind: 'pid-add', threadId, pid });
}

export function guardPidRemoved(threadId: string, pid: number): void {
  if (pid <= 0) return;
  pids.delete(pid);
  mutedPids.delete(pid);
  post({ kind: 'pid-remove', threadId, pid });
  if (pids.size === 0) armIdleStop();
}

export function guardStatus(): GuardStatus {
  return {
    running: worker !== null,
    hook,
    failure: failure ?? hookFailure,
    audio: audioFailure !== null ? 'failed' : muteEnabled ? 'on' : 'off',
    mutedPids: [...mutedPids],
  };
}

/** Test seams: a fake Worker, and a shorter idle stop. Both reset with `null`. */
export function setGuardWorkerForTests(factory: (() => GuardWorkerHandle) | null, idleMs: number | null = null): void {
  createWorker = factory ?? nativeWorker;
  idleStopMs = idleMs ?? IDLE_STOP_MS;
}

function wanted(): boolean {
  return enabled || muteEnabled;
}

function settingsChanged(): void {
  if (!wanted()) {
    armIdleStop();
    return;
  }
  if (pids.size === 0) return;
  cancelIdleStop();
  ensureWorker();
}

function post(command: GuardWorkerCommand): void {
  worker?.postMessage(command);
}

/** True when this call built the Worker and already told it every pid. */
function ensureWorker(): boolean {
  if (worker !== null || failure !== null || !wanted()) return false;
  const shared = new SharedArrayBuffer(4);
  let created: GuardWorkerHandle;
  try {
    created = createWorker();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return false;
  }
  stopFlag = new Int32Array(shared);
  created.onmessage = (event: { data: unknown }): void => {
    onWorkerMessage(event.data as GuardWorkerMessage);
  };
  created.onerror = (event: unknown): void => {
    fail(describeWorkerError(event));
  };
  created.postMessage({ kind: 'start', stop: shared, waitMs: WAIT_MS, enabled, mute: muteEnabled });
  for (const [pid, threadId] of pids) created.postMessage({ kind: 'pid-add', threadId, pid });
  // The core exits on its own terms; a pump that is still waiting must never
  // be what keeps the process alive.
  created.unref?.();
  worker = created;
  return true;
}

function describeWorkerError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (typeof event === 'object' && event !== null && 'message' in event) {
    return String((event as { message: unknown }).message);
  }
  return 'worker error';
}

/**
 * The Worker cannot run. It is stopped rather than dropped: an unreferenced
 * Worker keeps its thread and its heap until the process exits, and one that
 * already hooked must unhook first.
 */
function fail(reason: string): void {
  if (failure !== null) return;
  failure = reason;
  const running = worker;
  const flag = stopFlag;
  const hooked = hook !== null;
  worker = null;
  stopFlag = null;
  hook = null;
  cancelIdleStop();
  if (running !== null) {
    if (hooked) track(stopWorker(running, flag));
    else running.terminate();
  }
  sink?.note(`the focus guard is off: ${reason}`);
}

function onWorkerMessage(message: GuardWorkerMessage): void {
  switch (message.kind) {
    case 'ready':
      hook = message.hook;
      return;
    case 'hook-failed':
      hookFailure = message.reason;
      sink?.note(`the focus guard is off, the audio mute stays on: ${message.reason}`);
      return;
    case 'foreground-pushed':
      sink?.pushed(message.threadId, message.pid, message.title, message.restored);
      return;
    case 'session-muted':
      // A mute that took is the proof the audio half works, whatever refused once.
      audioFailure = null;
      mutedPids.add(message.pid);
      sink?.muted(message.threadId, message.pid);
      return;
    case 'audio-failed':
      audioFailure = message.message;
      sink?.note(`the audio mute is off: ${message.message}`);
      return;
    case 'failed':
      fail(message.reason);
      return;
    default:
      return;
  }
}

function armIdleStop(): void {
  if (worker === null || idleTimer !== null) return;
  const timer = setTimeout(idleStop, idleStopMs);
  timer.unref();
  idleTimer = timer;
}

function cancelIdleStop(): void {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

/** Nothing traced runs, or nothing is wanted of the Worker: let it go. */
function idleStop(): void {
  idleTimer = null;
  if (worker === null || (pids.size > 0 && wanted())) return;
  const running = worker;
  const flag = stopFlag;
  worker = null;
  stopFlag = null;
  hook = null;
  hookFailure = null;
  audioFailure = null;
  // The Worker gives back every session it holds on its way out.
  mutedPids.clear();
  track(stopWorker(running, flag));
}

function track(stop: Promise<void>): void {
  stopping.add(stop);
  void stop.then(() => stopping.delete(stop));
}

function teardown(): Promise<void> {
  cancelIdleStop();
  const running = worker;
  const flag = stopFlag;
  worker = null;
  stopFlag = null;
  hook = null;
  failure = null;
  hookFailure = null;
  audioFailure = null;
  pids.clear();
  mutedPids.clear();
  if (running !== null) track(stopWorker(running, flag));
  return Promise.all([...stopping]).then(() => undefined);
}

/**
 * The pump leaves within one wait, unhooks, unmutes and posts 'stopped'.
 * Terminating before that would leave the system hook installed until the
 * process exits and the sessions it held muted.
 */
function stopWorker(running: GuardWorkerHandle, flag: Int32Array | null): Promise<void> {
  if (flag !== null) Atomics.store(flag, 0, 1);
  return new Promise<void>((resolve) => {
    let released = false;
    const once = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      running.terminate();
      resolve();
    };
    running.onmessage = (event: { data: unknown }): void => {
      if ((event.data as GuardWorkerMessage).kind === 'stopped') once();
    };
    running.onerror = (): void => {
      once();
    };
    // Not unref'd: this timer is what a shutdown awaits, and it is bounded.
    const timer = setTimeout(once, 1000);
  });
}
