/**
 * Drains one I/O completion port for every thread Job Object and posts each
 * packet to the main thread. `GetQueuedCompletionStatus` blocks, which is why
 * this lives in a Worker: a job notification reaches the core in about a
 * millisecond and nothing is missed, where polling loses a process that lived
 * less than one interval.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { jobPacketAction } from './jobs-packets.ts';
import { processEventDiagnostic } from '../../process-event-diagnostics.ts';

export interface JobsWorkerStart {
  /** The completion port handle. Handles are process wide, so a Worker thread shares them. */
  port: number;
  /** One Int32: the main thread writes 1 to ask the loop to stop. */
  stop: SharedArrayBuffer;
  /**
   * Milliseconds one blocking wait lasts before the stop flag is checked again.
   * The core passes INFINITE and wakes the wait with a key 0 packet instead.
   */
  waitMs: number;
  /** The access the core inspects a process with; a new process is opened with it here, at once. */
  inspectAccess: number;
  /** The global job's key: of its packets only the budget alert is posted. */
  globalKey: number;
  /** Correlates diagnostic sequences across Worker restarts in the same host. */
  workerId?: string;
}

export type JobsWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped' }
  /** `handle`: for a new process, a handle opened on arrival (the core owns and closes it), else 0. */
  | { kind: 'packet'; message: number; key: number; pid: number; handle: number; sequence?: number; workerId?: string };

const scope = globalThis as unknown as {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: JobsWorkerMessage): void;
};

function send(message: JobsWorkerMessage): void {
  scope.postMessage(message);
}

scope.onmessage = (event: { data: unknown }): void => {
  const start = event.data as JobsWorkerStart;
  let symbols;
  try {
    symbols = dlopen('kernel32.dll', {
      GetQueuedCompletionStatus: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      GetLastError: {args: [], returns: FFIType.u32},
    }).symbols;
  } catch (error) {
    send({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    return;
  }

  const stop = new Int32Array(start.stop);
  // One buffer, three out parameters: bytes u32 at 0, completion key at 8, overlapped at 16.
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer);
  let sequence = 0;
  let waitError: number | null = null;

  processEventDiagnostic('worker.ready', {workerId: start.workerId ?? null});
  send({ kind: 'ready' });
  while (Atomics.load(stop, 0) === 0) {
    const ok = symbols.GetQueuedCompletionStatus(start.port, ptr(out, 0), ptr(out, 8), ptr(out, 16), start.waitMs);
    if (ok === 0) {
      const error = symbols.GetLastError();
      if (error !== waitError) processEventDiagnostic('worker.wait-failed', {workerId: start.workerId ?? null, error});
      waitError = error;
      continue;
    }
    waitError = null;
    const key = Number(view.getBigUint64(8, true));
    // Key 0 is no job: it is the main thread waking this wait to stop. One left
    // queued by a Worker that stopped on the flag before reading it reaches the
    // next Worker, whose flag is still down: that one waits again.
    if (key === 0) {
      if (Atomics.load(stop, 0) !== 0) break;
      continue;
    }
    // For a job packet the byte count carries the message, and the overlapped
    // pointer carries the pid rather than an address.
    const message = view.getUint32(0, true);
    const pid = Number(view.getBigUint64(16, true));
    const action = jobPacketAction(message, key, pid, start.globalKey);
    const packetSequence = ++sequence;
    // The global job's copy of a start or exit: the thread job's copy is the one traced.
    if (action === 'drop') {
      processEventDiagnostic('worker.packet', {workerId: start.workerId ?? null, sequence: packetSequence, message, key, pid, action});
      continue;
    }
    // Opened here, microseconds after the kernel queued the packet: the core's
    // own thread may read it much later, when a short-lived process is gone.
    const handle = action === 'open' ? Number(symbols.OpenProcess(start.inspectAccess, 0, pid) ?? 0) : 0;
    const openError = action === 'open' && handle === 0 ? symbols.GetLastError() : 0;
    processEventDiagnostic('worker.packet', {workerId: start.workerId ?? null, sequence: packetSequence, message, key, pid, action});
    if (action === 'open') processEventDiagnostic('worker.open', {workerId: start.workerId ?? null, sequence: packetSequence, pid, captured: handle !== 0, error: openError});
    send({ kind: 'packet', message, key, pid, handle, sequence: packetSequence, workerId: start.workerId });
  }
  // Removing the message listener lets Bun end this Worker naturally, after
  // the native wait has returned and every packet has been sent.
  scope.onmessage = null;
  processEventDiagnostic('worker.stopped', {workerId: start.workerId ?? null});
  send({ kind: 'stopped' });
};
