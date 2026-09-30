import { expect, test } from 'bun:test';
import { dlopen, FFIType } from 'bun:ffi';
import type { JobsWorkerMessage } from '../src/platform/windows/jobs-worker.ts';

const testWindows = process.platform === 'win32' ? test : test.skip;

testWindows('the native drain can close and collect its buffers before the next worker starts', async () => {
  const library = dlopen('kernel32.dll', {
    CreateIoCompletionPort: { args: ['u64', 'u64', 'u64', 'u32'], returns: FFIType.u64 },
    PostQueuedCompletionStatus: { args: ['u64', 'u32', 'u64', 'ptr'], returns: FFIType.i32 },
    CloseHandle: { args: ['u64'], returns: FFIType.i32 },
  });
  const api = library.symbols;
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const port = api.CreateIoCompletionPort(0xffffffffffffffffn, 0n, 0n, 1);
      expect(port).not.toBe(0n);
      const shared = new SharedArrayBuffer(4);
      const stop = new Int32Array(shared);
      const worker = new Worker(new URL('../src/platform/windows/jobs-worker.ts', import.meta.url).href);
      let packet = false;
      const closed = new Promise<void>(resolve => worker.addEventListener('close', () => resolve(), { once: true }));
      const ready = new Promise<void>((resolve, reject) => {
        worker.onerror = reject;
        worker.onmessage = (event: MessageEvent<JobsWorkerMessage>) => {
          if (event.data.kind === 'ready') resolve();
          if (event.data.kind === 'failed') reject(new Error(event.data.reason));
          if (event.data.kind === 'packet') {
            packet = true;
            Atomics.store(stop, 0, 1);
            api.PostQueuedCompletionStatus(port, 0, 0n, null);
          }
        };
      });
      const timeout = setTimeout(() => {
        Atomics.store(stop, 0, 1);
        api.PostQueuedCompletionStatus(port, 0, 0n, null);
        worker.terminate();
      }, 5000);
      try {
        worker.postMessage({ port: Number(port), stop: shared, waitMs: 0xffffffff, inspectAccess: 0 });
        await ready;
        expect(api.PostQueuedCompletionStatus(port, 4, 2n, null)).toBe(1);
        await closed;
        expect(packet).toBe(true);
      } finally {
        Atomics.store(stop, 0, 1);
        api.PostQueuedCompletionStatus(port, 0, 0n, null);
        await closed;
        clearTimeout(timeout);
        api.CloseHandle(port);
      }
      Bun.gc(true);
    }
  } finally { library.close(); }
}, 30000);
