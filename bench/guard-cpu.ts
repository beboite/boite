/**
 * Process CPU of the Windows guard Worker over `seconds`, with the mute on and
 * one traced pid (a `ping` that opens no audio session), so the figure is the
 * Worker's pump and audio walks; the main thread only waits. `nopid` traces
 * nothing. `worker` measures another copy of `guard-worker.ts`, such as an
 * older checkout's. Windows only. Prints one JSON line.
 *
 *   bun bench/guard-cpu.ts [seconds=60] [nopid] [worker=packages/core/src/platform/windows/guard-worker.ts]
 */
import { join } from 'node:path';

if (process.platform !== 'win32') throw new Error('guard-cpu: Windows only');
const seconds = Number(process.argv[2] ?? 60);
const traced = process.argv[3] !== 'nopid';
const workerPath = process.argv[4] ?? join(import.meta.dir, '../packages/core/src/platform/windows/guard-worker.ts');

const worker = new Worker(workerPath);
let muted = 0;
worker.onmessage = (event) => {
  if ((event.data as { kind: string }).kind === 'session-muted') muted++;
};
const stop = new SharedArrayBuffer(4);
worker.postMessage({ kind: 'start', stop, waitMs: 100, enabled: false, mute: true });
const child = Bun.spawn(['ping', '-n', String(seconds + 15), '127.0.0.1'], { stdout: 'ignore', stderr: 'ignore' });
try {
  await Bun.sleep(2000);
  if (traced) worker.postMessage({ kind: 'pid-add', threadId: 'thr_bench', pid: child.pid });
  // Past the first walks and the endpoint's registration.
  await Bun.sleep(3000);
  const start = process.cpuUsage();
  await Bun.sleep(seconds * 1000);
  const used = process.cpuUsage(start);
  console.log(JSON.stringify({
    date: new Date().toISOString(),
    seconds,
    traced,
    cpuMs: Math.round((used.user + used.system) / 1000),
    muted,
  }));
} finally {
  child.kill();
  await child.exited;
  Atomics.store(new Int32Array(stop), 0, 1);
  await Bun.sleep(300);
  worker.terminate();
}
