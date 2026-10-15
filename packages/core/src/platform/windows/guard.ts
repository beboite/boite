/**
 * The focus guard's main-thread half, and the audio mute's: it holds the pid set
 * the Worker filters on, forwards both settings, and turns what the Worker
 * pushed back into events.
 *
 * Nothing native happens here. The Worker is built on the first traced pid, the
 * same way the Job Object one is, so a core that never launches a process never
 * pays for a Worker, a `user32.dll` handle, a system-wide hook or a COM
 * apartment. It is stopped again once nothing traced has run for a while, or
 * once both protections are off, so an idle core does not keep a pump waking at
 * all. While it runs, every command is followed by a `WM_NULL` to the pump's
 * thread, so the pump waits a second at a time rather than a tenth.
 * Other operating systems use the separate POSIX backend.
 */
import { workerEntry } from './worker-entry.ts';
import type { GuardWorkerCommand, GuardWorkerMessage } from './guard-worker.ts';
import { PUMP_LONG_WAIT_MS, PUMP_POSTED, PUMP_SLOTS, PUMP_STOP, PUMP_WAKEABLE } from './guard-pump.ts';
import { wakePump } from './guard-wake.ts';

import type { GuardEventSink, GuardStatus } from '../types.ts';

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
let wake: (threadId: number) => boolean = wakePump;

let refCount = 0;
let sink: GuardEventSink | null = null;
let worker: GuardWorkerHandle | null = null;
/** Shared with the Worker: stop flag, commands posted, wakeable (guard-pump.ts). */
let control: Int32Array | null = null;
/** The running Worker's pump thread, once it said which one it is. */
let pumpThread: number | null = null;
let hook: string | null = null;
/** The Worker could not run at all. No new one is built until the core's teardown. */
let failure: string | null = null;
/** Only the focus hook was refused; the Worker keeps muting. */
let hookFailure: string | null = null;
let enabled = true;
let muteEnabled = true;
let audioFailure: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Every note already written to the core log. It outlives the Worker: one is
 * rebuilt on every turn after an idle stop, and a machine with no audio endpoint
 * or no interactive desktop would otherwise say so once per turn. Cleared only
 * by the core's teardown.
 */
const noted = new Set<string>();
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

/**
 * A turn is starting: have the hook in before its first process can open a
 * window. With nothing traced running, the idle window starts over from here:
 * a stop armed by the previous turn's last exit must not take the Worker this
 * turn just warmed.
 */
export function warmGuard(): void {
  if (!wanted()) return;
  ensureWorker();
  if (pids.size > 0) return;
  cancelIdleStop();
  armIdleStop();
}

export function guardPidAdded(threadId: string, pid: number): void {
  if (pid <= 0) return;
  pids.set(pid, threadId);
  // With both protections off the stop armed by the switch stays armed, however
  // many pids keep coming.
  if (wanted()) cancelIdleStop();
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

/** Test seams: a fake Worker, a shorter idle stop and a fake wake. All reset with `null`. */
export function setGuardWorkerForTests(
  factory: (() => GuardWorkerHandle) | null,
  idleMs: number | null = null,
  wakeFake: ((threadId: number) => boolean) | null = null,
): void {
  createWorker = factory ?? nativeWorker;
  idleStopMs = idleMs ?? IDLE_STOP_MS;
  wake = wakeFake ?? wakePump;
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

function post(command: Exclude<GuardWorkerCommand, { kind: 'start' }>): void {
  if (worker === null || control === null) return;
  // Counted before it is sent: the pump never blocks while one is in flight.
  Atomics.add(control, PUMP_POSTED, 1);
  worker.postMessage(command);
  wakeWorker();
}

/**
 * Ends the pump's wait so it hands the event loop over to the command. A wake
 * that fails puts the pump back on its short wait for the Worker's life.
 */
function wakeWorker(): void {
  if (pumpThread === null || control === null) return;
  if (Atomics.load(control, PUMP_WAKEABLE) !== 1) return;
  if (wake(pumpThread)) return;
  Atomics.store(control, PUMP_WAKEABLE, 0);
  pumpThread = null;
}

/** True when this call built the Worker and already told it every pid. */
function ensureWorker(): boolean {
  if (worker !== null || failure !== null || !wanted()) return false;
  const shared = new SharedArrayBuffer(4 * PUMP_SLOTS);
  let created: GuardWorkerHandle;
  try {
    created = createWorker();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return false;
  }
  const slots = new Int32Array(shared);
  control = slots;
  pumpThread = null;
  created.onmessage = (event: { data: unknown }): void => {
    onWorkerMessage(event.data as GuardWorkerMessage);
  };
  created.onerror = (event: unknown): void => {
    fail(describeWorkerError(event));
  };
  created.postMessage({ kind: 'start', control: shared, enabled, mute: muteEnabled });
  for (const [pid, threadId] of pids) {
    Atomics.add(slots, PUMP_POSTED, 1);
    created.postMessage({ kind: 'pid-add', threadId, pid });
  }
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
  const flag = control;
  const thread = pumpThread;
  const hooked = hook !== null;
  worker = null;
  control = null;
  pumpThread = null;
  hook = null;
  cancelIdleStop();
  if (running !== null) {
    if (hooked) track(stopWorker(running, flag, thread));
    else running.terminate();
  }
  sink?.note(`the focus guard is off: ${reason}`);
}

function onWorkerMessage(message: GuardWorkerMessage): void {
  switch (message.kind) {
    case 'ready':
      hook = message.hook;
      return;
    case 'pump':
      // From here every command wakes the pump, which may wait a whole second.
      if (control === null) return;
      pumpThread = message.threadId;
      Atomics.store(control, PUMP_WAKEABLE, 1);
      return;
    case 'hook-failed':
      hookFailure = message.reason;
      noteOnce(`the focus guard is off, the audio mute stays on: ${message.reason}`);
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
      noteOnce(`the audio mute is off: ${message.message}`);
      return;
    case 'session-skipped':
      // The walk went on and muted the others: the mute is still on.
      noteOnce(`an audio session could not be read: ${message.message}`);
      return;
    case 'failed':
      fail(message.reason);
      return;
    default:
      return;
  }
}

function noteOnce(message: string): void {
  if (noted.has(message)) return;
  noted.add(message);
  sink?.note(message);
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
  const flag = control;
  const thread = pumpThread;
  worker = null;
  control = null;
  pumpThread = null;
  hook = null;
  hookFailure = null;
  audioFailure = null;
  // The Worker gives back every session it holds on its way out.
  mutedPids.clear();
  track(stopWorker(running, flag, thread));
}

function track(stop: Promise<void>): void {
  stopping.add(stop);
  void stop.then(() => stopping.delete(stop));
}

function teardown(): Promise<void> {
  cancelIdleStop();
  const running = worker;
  const flag = control;
  const thread = pumpThread;
  worker = null;
  control = null;
  pumpThread = null;
  hook = null;
  failure = null;
  hookFailure = null;
  audioFailure = null;
  pids.clear();
  mutedPids.clear();
  noted.clear();
  if (running !== null) track(stopWorker(running, flag, thread));
  return Promise.all([...stopping]).then(() => undefined);
}

/**
 * The pump leaves at once when the wake reaches it, else within one wait, then
 * unhooks, unmutes and posts 'stopped'. Terminating before that would leave the
 * system hook installed until the process exits and the sessions it held muted.
 */
function stopWorker(running: GuardWorkerHandle, flag: Int32Array | null, thread: number | null): Promise<void> {
  // A pump on its long wait that the wake did not reach leaves within that wait.
  let fallbackMs = 1000;
  if (flag !== null) {
    Atomics.store(flag, PUMP_STOP, 1);
    if (Atomics.load(flag, PUMP_WAKEABLE) === 1 && (thread === null || !wake(thread))) {
      fallbackMs += PUMP_LONG_WAIT_MS;
    }
  }
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
    const timer = setTimeout(once, fallbackMs);
  });
}
