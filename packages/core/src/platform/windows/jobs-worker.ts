/**
 * Drains one I/O completion port for every thread Job Object and posts each
 * packet to the main thread. `GetQueuedCompletionStatus` blocks, which is why
 * this lives in a Worker: a job notification reaches the core in about a
 * millisecond and nothing is missed, where polling loses a process that lived
 * less than one interval.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';

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
}

export type JobsWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped' }
  | { kind: 'packet'; message: number; key: number; pid: number };

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
    }).symbols;
  } catch (error) {
    send({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    return;
  }

  const stop = new Int32Array(start.stop);
  // One buffer, three out parameters: bytes u32 at 0, completion key at 8, overlapped at 16.
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer);

  send({ kind: 'ready' });
  while (Atomics.load(stop, 0) === 0) {
    const ok = symbols.GetQueuedCompletionStatus(start.port, ptr(out, 0), ptr(out, 8), ptr(out, 16), start.waitMs);
    if (ok === 0) continue;
    const key = Number(view.getBigUint64(8, true));
    // Key 0 is no job: it is the main thread waking this wait to stop.
    if (key === 0) break;
    // For a job packet the byte count carries the message, and the overlapped
    // pointer carries the pid rather than an address.
    send({
      kind: 'packet',
      message: view.getUint32(0, true),
      key,
      pid: Number(view.getBigUint64(16, true)),
    });
  }
  send({ kind: 'stopped' });
};
