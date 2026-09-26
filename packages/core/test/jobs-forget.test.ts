import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { processPlatform } from '../src/platform/index.ts';
import { threadJobCount } from '../src/platform/windows/jobs.ts';
import { ProcRegistry } from '../src/procs.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { waitFor } from './harness.ts';

const onWindows = process.platform === 'win32';
const describeWindows = onWindows ? describe : describe.skip;

const k32 = onWindows
  ? dlopen('kernel32.dll', {
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
      GetProcessHandleCount: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }).symbols
  : null;

function handleCount(): number {
  if (k32 === null) return 0;
  const out = new Uint32Array(1);
  k32.GetProcessHandleCount(k32.GetCurrentProcess(), ptr(out));
  return out[0] ?? 0;
}

const FORGET_MS = 100;
const SPAWNS = 20;

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
    procs = new ProcRegistry(journal, new Bus(), processPlatform, { forgetDelayMs: FORGET_MS });
  });

  afterEach(async () => {
    await procs.close();
    journal.close();
    if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
    else process.env.BOITE_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test('an id minted per call leaves no Job Object behind once the registry forgets it', async () => {
    // One warm-up spawn builds the global job, the port and the Worker, which
    // stay for the life of the core and are not what this measures.
    const warm = procs.spawn('warm-up', 'cmd', ['/c', 'exit 0']);
    await warm.exited;
    await waitFor(() => threadJobCount() === 0, 5000);
    const jobsBefore = threadJobCount();
    const handlesBefore = handleCount();

    const ids: string[] = [];
    for (let index = 0; index < SPAWNS; index += 1) {
      const id = `plugin:fetch:${index}`;
      ids.push(id);
      await procs.spawn(id, 'cmd', ['/c', 'exit 0']).exited;
    }
    expect(threadJobCount()).toBeGreaterThan(jobsBefore);
    await waitFor(() => ids.every((id) => procs.liveCount(id) === 0), 5000);

    await waitFor(() => threadJobCount() === jobsBefore, 5000);
    // The kernel's own count, the way the leak was measured: one handle per id.
    expect(handleCount() - handlesBefore).toBeLessThan(SPAWNS / 2);
  }, 30000);

  test('the drain Worker sleeps until a packet and stops as soon as it is asked', async () => {
    // Neither protection on, so no guard Worker: what the close waits for is the drain.
    procs.applySettings({ ...DEFAULT_SETTINGS, focusGuard: false, muteAgents: false });
    await procs.spawn('drain', 'cmd', ['/c', 'exit 0']).exited;
    await waitFor(() => procs.liveCount('drain') === 0, 5000);
    // Its wait has no timeout, so only the packet teardown posts can end it.
    await Bun.sleep(300);
    const started = performance.now();
    await procs.close();
    expect(performance.now() - started).toBeLessThan(100);
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
