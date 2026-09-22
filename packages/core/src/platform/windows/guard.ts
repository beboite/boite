/**
 * The focus guard's main-thread half, and the audio mute's: it holds the pid set
 * the Worker filters on, forwards both settings, and turns what the Worker
 * pushed back into events.
 *
 * Nothing native happens here. The Worker is built on the first traced pid, the
 * same way the Job Object one is, so a core that never launches a process never
 * pays for a Worker, a `user32.dll` handle, a system-wide hook or a COM
 * apartment. Other operating systems use the separate POSIX backend.
 */
import { workerEntry } from './worker-entry.ts';
import type { GuardWorkerCommand, GuardWorkerMessage } from './guard-worker.ts';

import type { GuardEventSink, GuardStatus } from '../types.ts';

/** One bounded wait on the message queue before the stop flag is read again. */
const WAIT_MS = 100;

let refCount = 0;
let sink: GuardEventSink | null = null;
let worker: Worker | null = null;
let stopFlag: Int32Array | null = null;
let hook: string | null = null;
let failure: string | null = null;
let enabled = true;
let muteEnabled = true;
let audioFailure: string | null = null;
/** The pids the Worker said it muted, minus the ones that have since exited. */
const mutedPids = new Set<number>();

export function retainGuard(events: GuardEventSink): void {
  refCount += 1;
  sink = events;
}

export function releaseGuard(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  sink = null;
  teardown();
}

export function setGuardEnabled(next: boolean): void {
  enabled = next;
  post({ kind: 'set', enabled: next, mute: muteEnabled });
}

export function setGuardMute(next: boolean): void {
  muteEnabled = next;
  // The Worker unmutes everything it holds when it is turned off, so nothing is
  // left muted behind a switch the user just moved.
  if (!next) mutedPids.clear();
  post({ kind: 'set', enabled, mute: next });
}

export function guardPidAdded(threadId: string, pid: number): void {
  if (pid <= 0) return;
  ensureWorker();
  post({ kind: 'pid-add', threadId, pid });
}

export function guardPidRemoved(threadId: string, pid: number): void {
  if (pid <= 0) return;
  mutedPids.delete(pid);
  post({ kind: 'pid-remove', threadId, pid });
}

export function guardStatus(): GuardStatus {
  return {
    running: worker !== null,
    hook,
    failure,
    audio: audioFailure !== null ? 'failed' : muteEnabled ? 'on' : 'off',
    mutedPids: [...mutedPids],
  };
}

function post(command: GuardWorkerCommand): void {
  worker?.postMessage(command);
}

function ensureWorker(): void {
  if (worker !== null || failure !== null) return;
  const shared = new SharedArrayBuffer(4);
  stopFlag = new Int32Array(shared);
  try {
    const created = new Worker(workerEntry(import.meta.url, 'guard-worker'));
    created.onmessage = (event: { data: unknown }): void => {
      onWorkerMessage(event.data as GuardWorkerMessage);
    };
    created.onerror = (event: unknown): void => {
      fail(describeWorkerError(event));
    };
    const start: GuardWorkerCommand = { kind: 'start', stop: shared, waitMs: WAIT_MS, enabled, mute: muteEnabled };
    created.postMessage(start);
    // The core exits on its own terms; a pump that is still waiting must never
    // be what keeps the process alive.
    if ('unref' in created && typeof created.unref === 'function') created.unref();
    worker = created;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function describeWorkerError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (typeof event === 'object' && event !== null && 'message' in event) {
    return String((event as { message: unknown }).message);
  }
  return 'worker error';
}

function fail(reason: string): void {
  if (failure !== null) return;
  failure = reason;
  worker = null;
  hook = null;
  sink?.note(`the focus guard is off: ${reason}`);
}

function onWorkerMessage(message: GuardWorkerMessage): void {
  switch (message.kind) {
    case 'ready':
      hook = message.hook;
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

function teardown(): void {
  const running = worker;
  const flag = stopFlag;
  worker = null;
  stopFlag = null;
  hook = null;
  failure = null;
  audioFailure = null;
  mutedPids.clear();
  if (running === null) return;

  if (flag !== null) Atomics.store(flag, 0, 1);
  let released = false;
  const once = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    running.terminate();
  };
  // The pump leaves within one wait, unhooks and posts 'stopped'. Terminating
  // before that would leave the system hook installed until the process exits.
  running.onmessage = (event: { data: unknown }): void => {
    if ((event.data as GuardWorkerMessage).kind === 'stopped') once();
  };
  const timer = setTimeout(once, 1000);
  if (typeof timer.unref === 'function') timer.unref();
}
