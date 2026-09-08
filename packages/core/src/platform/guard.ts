/**
 * The focus guard's main-thread half: it holds the pid set the Worker filters
 * on, forwards the setting, and turns what the Worker pushed back into events.
 *
 * Nothing native happens here. The Worker is built on the first traced pid, the
 * same way the Job Object one is, so a core that never launches a process never
 * pays for a Worker, a `user32.dll` handle or a system-wide hook. Off Windows
 * every function is a no-op.
 */
import { workerEntry } from './worker-entry.ts';
import type { GuardWorkerCommand, GuardWorkerMessage } from './guard-worker.ts';

/** What the registry wants to hear about. Set once by `ProcRegistry`. */
export interface GuardEventSink {
  pushed(threadId: string, pid: number, title: string, restored: boolean): void;
  note(message: string): void;
}

/** What a test reads to know the hook is really in. */
export interface GuardStatus {
  /** True between the first traced pid and the core's own teardown. */
  running: boolean;
  /** The `HWINEVENTHOOK` in decimal, once the Worker answered `ready`. */
  hook: string | null;
  failure: string | null;
}

/** One bounded wait on the message queue before the stop flag is read again. */
const WAIT_MS = 100;

const isWindows = process.platform === 'win32';

let refCount = 0;
let sink: GuardEventSink | null = null;
let worker: Worker | null = null;
let stopFlag: Int32Array | null = null;
let hook: string | null = null;
let failure: string | null = null;
let enabled = true;

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
  post({ kind: 'set', enabled: next });
}

export function guardPidAdded(threadId: string, pid: number): void {
  if (!isWindows || pid <= 0) return;
  ensureWorker();
  post({ kind: 'pid-add', threadId, pid });
}

export function guardPidRemoved(threadId: string, pid: number): void {
  if (!isWindows || pid <= 0) return;
  post({ kind: 'pid-remove', threadId, pid });
}

export function guardStatus(): GuardStatus {
  return { running: worker !== null, hook, failure };
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
    const start: GuardWorkerCommand = { kind: 'start', stop: shared, waitMs: WAIT_MS, enabled };
    created.postMessage(start);
    // The core exits on its own terms; a pump that is still waiting must never
    // be what keeps the process alive.
    if (typeof created.unref === 'function') created.unref();
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
