import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { registryPlatform } from '../src/platform/index.ts';
import { threadJobCount } from '../src/platform/windows/jobs.ts';
import { ProcRegistry } from '../src/procs.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { waitFor } from './harness.ts';

const onWindows = process.platform === 'win32';
const describeWindows = onWindows ? describe : describe.skip;

const k32 = onWindows
  ? dlopen('kernel32.dll', { GetCurrentProcess: { args: [], returns: FFIType.ptr } }).symbols
  : null;
const nt = onWindows
  ? dlopen('ntdll.dll', {
      NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      NtQueryObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols
  : null;

const PROCESS_HANDLE_SNAPSHOT = 51;
const OBJECT_TYPE_INFORMATION = 2;
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;
const typeNames = new Map<number, string>();

function typeNameOf(handle: bigint): string {
  if (nt === null) return '?';
  const buffer = new Uint8Array(1024);
  if (nt.NtQueryObject(handle, OBJECT_TYPE_INFORMATION, ptr(buffer), buffer.length, null) !== 0) return '?';
  // A UNICODE_STRING first: its length in bytes, then a pointer into this buffer.
  const view = new DataView(buffer.buffer);
  const start = Number(view.getBigUint64(8, true)) - Number(ptr(buffer));
  return new TextDecoder('utf-16le').decode(buffer.subarray(start, start + view.getUint16(0, true)));
}

/**
 * This process's handles by kernel object type. A total count also moves with
 * Bun's own worker threads and the subprocess wrappers its collector frees
 * late, neither of which is a Job Object: on a loaded runner Bun 1.4.3 held 22
 * more after 20 spawns with no job left.
 */
function handlesByType(): Map<string, number> {
  const counts = new Map<string, number>();
  if (nt === null || k32 === null) return counts;
  for (let size = 1 << 16; ; size *= 2) {
    const buffer = new Uint8Array(size);
    const status = nt.NtQueryInformationProcess(k32.GetCurrentProcess(), PROCESS_HANDLE_SNAPSHOT, ptr(buffer), size, null);
    if (status === STATUS_INFO_LENGTH_MISMATCH) continue;
    if (status !== 0) throw new Error(`the handle snapshot failed with status ${status}`);
    // PROCESS_HANDLE_SNAPSHOT_INFORMATION: a count, a reserved word, then 40-byte entries.
    const view = new DataView(buffer.buffer);
    const count = Number(view.getBigUint64(0, true));
    for (let index = 0; index < count; index += 1) {
      const at = 16 + index * 40;
      const typeIndex = view.getUint32(at + 28, true);
      let name = typeNames.get(typeIndex);
      if (name === undefined) {
        name = typeNameOf(view.getBigUint64(at, true));
        typeNames.set(typeIndex, name);
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }
}

function handlesAbove(before: Map<string, number>): Record<string, number> {
  const now = handlesByType();
  const above: Record<string, number> = {};
  for (const name of new Set([...before.keys(), ...now.keys()])) {
    const delta = (now.get(name) ?? 0) - (before.get(name) ?? 0);
    if (delta !== 0) above[name] = delta;
  }
  return above;
}

const FORGET_MS = 100;
const SPAWNS = 20;
const LEAK_TEST = 'an id minted per call leaves no Job Object behind once the registry forgets it';

describeWindows('thread jobs of forgotten threads', () => {
  let directory: string;
  let previousDataDir: string | undefined;
  let journal: Journal;
  let procs: ProcRegistry;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'boite-jobs-forget-'));
    previousDataDir = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    journal = new Journal(join(directory, 'journal.db'));
    procs = new ProcRegistry(journal, new Bus(), registryPlatform(), { forgetDelayMs: FORGET_MS });
  });

  afterEach(async () => {
    await procs.close();
    journal.close();
    if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
    else process.env.BOITE_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test(LEAK_TEST, async () => {
    // GetProcessHandleCount includes every concurrent test in this process.
    // Keep the kernel assertion in a child that runs only this scenario.
    if (process.env.BOITE_JOB_HANDLE_PROBE !== '1') {
      const child = procs.spawn('handle-probe', process.execPath, ['test', import.meta.filename, '--test-name-pattern', LEAK_TEST], {
        env: { BOITE_JOB_HANDLE_PROBE: '1' },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.proc.stdout).text(),
        new Response(child.proc.stderr).text(),
        child.exited,
      ]);
      expect(code, stdout + stderr).toBe(0);
      return;
    }
    const ids: string[] = [];
    const waitForState = async (label: string, predicate: () => boolean): Promise<void> => {
      try { await waitFor(predicate, 5000); }
      catch (cause) {
        const pending = ['warm-up', ...ids].map(id => ({ id, live: procs.liveCount(id), job: procs.platform.sample(id) }))
          .filter(entry => entry.live > 0 || entry.job !== null);
        throw new Error(`${label}: ${threadJobCount()} thread jobs; ${JSON.stringify(pending)}`, { cause });
      }
    };
    // One warm-up spawn builds the global job, the port and the Worker, which
    // stay for the life of the core and are not what this measures.
    // Drain both output pipes before counting native handles. An exited Bun
    // subprocess can still own its unread pipe handles until garbage collection.
    const exitQuietly = async (id: string) => {
      const child = procs.spawn(id, 'cmd', ['/c', 'exit 0']);
      await Promise.all([
        new Response(child.proc.stdout).text(),
        new Response(child.proc.stderr).text(),
        child.exited,
      ]);
    };
    await exitQuietly('warm-up');
    await waitForState('warm-up job was not forgotten', () => threadJobCount() === 0);
    const jobsBefore = threadJobCount();
    Bun.gc(true);
    const handlesBefore = handlesByType();

    for (let index = 0; index < SPAWNS; index += 1) {
      const id = `plugin:fetch:${index}`;
      ids.push(id);
      await exitQuietly(id);
    }
    expect(threadJobCount()).toBeGreaterThan(jobsBefore);
    await waitForState('minted processes remain live', () => ids.every((id) => procs.liveCount(id) === 0));

    await waitForState('minted jobs were not forgotten', () => threadJobCount() === jobsBefore);
    // The kernel assertion: not one Job Object handle above the baseline. No
    // collection is needed, Bun's collector never owns a Job Object.
    const above = handlesAbove(handlesBefore);
    expect(above.Job ?? 0, `handles above the baseline after ${SPAWNS} spawns: ${JSON.stringify(above)}`).toBe(0);
    // A process handle the jobs module kept would stay too. Bun owns one per
    // subprocess until the wrapper is collected, so those get a collection.
    try {
      await waitFor(() => {
        Bun.gc(true);
        return (handlesAbove(handlesBefore).Process ?? 0) < SPAWNS / 2;
      }, 20000);
    } catch (cause) {
      throw new Error(`handles above the baseline after ${SPAWNS} spawns: ${JSON.stringify(handlesAbove(handlesBefore))}`, { cause });
    }
  }, 30000);

  test('the drain Worker sleeps until a packet and stops as soon as it is asked', async () => {
    // Neither protection on, so no guard Worker: what the close waits for is the drain.
    procs.applySettings({ ...DEFAULT_SETTINGS, focusGuard: false, muteAgents: false });
    await procs.spawn('drain', 'cmd', ['/c', 'exit 0']).exited;
    await waitFor(() => procs.liveCount('drain') === 0, 5000);
    // Its wait has no timeout, so only the packet teardown posts can end it.
    await Bun.sleep(300);
    const started = performance.now();
    const terminate = Worker.prototype.terminate;
    let forcedStops = 0;
    Worker.prototype.terminate = function (this: Worker) { forcedStops += 1; return terminate.call(this); };
    try {
      await procs.close();
      expect(performance.now() - started).toBeLessThan(100);
      // Acknowledging the stop permits natural Worker exit; reserve forced
      // termination for a loop that does not acknowledge shutdown.
      expect(forcedStops).toBe(0);
    } finally { Worker.prototype.terminate = terminate; }
  }, 30000);

  test('a job forgotten before its console host exits closes once the host is gone', async () => {
    // The registry never traces a console host, and the one a piped `cmd` gets
    // exits after `cmd`. Forgetting at once puts the forget before that exit.
    await procs.close();
    procs = new ProcRegistry(journal, new Bus(), registryPlatform(), { forgetDelayMs: 0 });
    // A cold drain Worker reports `cmd`'s exit late, and the registry's 1 s
    // fallback forgets after the host is gone. Warm it first.
    const quiet = async (id: string): Promise<void> => {
      const child = procs.spawn(id, 'cmd', ['/c', 'exit 0']);
      await Promise.all([new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text(), child.exited]);
      await waitFor(() => procs.liveCount(id) === 0, 5000);
    };
    await quiet('warm-up');
    await quiet('host-late');
    await waitFor(() => threadJobCount() === 0, 5000);
  }, 30000);

  test('a thread spawning again after it was forgotten gets a job of its own', async () => {
    await procs.spawn('again', 'cmd', ['/c', 'exit 0']).exited;
    await waitFor(() => procs.liveCount('again') === 0, 5000);
    await waitFor(() => threadJobCount() === 0, 5000);

    const second = procs.spawn('again', 'ping', ['-n', '30', '127.0.0.1']);
    expect(threadJobCount()).toBe(1);
    expect(procs.killTree('again')).toBe(1);
    await second.exited;
  }, 30000);
});
