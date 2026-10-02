import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { ProcRegistry } from '../src/procs.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import type { ProcessEventSink, ProcessPlatform } from '../src/platform/types.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { waitFor } from './harness.ts';

const GRACE_MS = 40;
const THREAD = 'orphans';
/** The creation time the fake system gives a process the core spawned. */
const SPAWN_BORN = 7000;

/** A job that reports what the test says and records what the registry stops. */
function fakeJob(): {
  platform: ProcessPlatform;
  sink: () => ProcessEventSink;
  stopped: number[];
  /** What the system answers for a pid, apart from the registry: when its running process was created. */
  running: Map<number, number>;
} {
  let events: ProcessEventSink | null = null;
  const stopped: number[] = [];
  const running = new Map<number, number>();
  const platform: ProcessPlatform = {
    ...createPosixPlatform('linux'),
    retain(jobs) {
      events = jobs;
    },
    terminateProcess(threadId, pid) {
      stopped.push(pid);
      events?.exited(threadId, pid, { exitCode: 9, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
      return true;
    },
    // A core spawn joins the job, as on Windows, and the system dates it.
    attach: () => true,
    startedAt: () => SPAWN_BORN,
    runningSince: (pid) => running.get(pid) ?? null,
  };
  return {
    platform,
    stopped,
    running,
    sink: () => {
      if (events === null) throw new Error('the registry never retained the platform');
      return events;
    },
  };
}

function turn(name: 'turn.started' | 'turn.finished'): [typeof name, Turn] {
  return [name, { threadId: THREAD } as Turn];
}

describe('orphan sweep', () => {
  let directory: string;
  let journal: Journal;
  let bus: Bus;
  let job: ReturnType<typeof fakeJob>;
  let procs: ProcRegistry;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'boite-orphans-'));
    previousDataDir = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    journal = new Journal(join(directory, 'journal.db'));
    bus = new Bus();
    job = fakeJob();
    procs = new ProcRegistry(journal, bus, job.platform, { orphanGraceMs: GRACE_MS });
    procs.applySettings(DEFAULT_SETTINGS);
    // The agent, its MCP server, a shell, what the shell started and its child.
    const sink = job.sink();
    sink.started(THREAD, 100, { exe: 'C:\\agent\\claude.exe', commandLine: null, parentPid: process.pid });
    sink.started(THREAD, 101, { exe: 'C:\\tools\\mcp.exe', commandLine: null, parentPid: 100 });
    sink.started(THREAD, 102, { exe: 'C:\\Windows\\cmd.exe', commandLine: null, parentPid: 100 });
    sink.started(THREAD, 103, { exe: 'C:\\tools\\bun.exe', commandLine: null, parentPid: 102 });
    sink.started(THREAD, 104, { exe: 'C:\\tools\\chrome.exe', commandLine: null, parentPid: 103 });
    sink.started(THREAD, 105, { exe: 'C:\\tools\\unknown.exe', commandLine: null, parentPid: null });
    // An interrupted command: the shell goes, what it started stays.
    sink.exited(THREAD, 102, { exitCode: 1, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
  });

  afterEach(async () => {
    await procs.close();
    journal.close();
    if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
    else process.env.BOITE_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test('a finished turn stops what lost its parent, with its children, and nothing else', async () => {
    bus.emit(...turn('turn.finished'));
    await waitFor(() => job.stopped.length === 2, 2000);
    expect(job.stopped.sort()).toEqual([103, 104]);
    expect(procs.liveOf(THREAD).map((record) => record.pid).sort()).toEqual([100, 101, 105]);
  });

  test('a process younger than the grace is left alone', () => {
    // SQLite fixture writes can take longer than the short test grace. Use the
    // captured births so this checks age, independently of setup latency.
    const births = procs.liveOf(THREAD).filter(record => record.pid === 103 || record.pid === 104).map(record => record.startedAt);
    expect(procs.sweepOrphans(THREAD, Math.min(...births) + GRACE_MS - 1)).toEqual([]);
    expect(procs.sweepOrphans(THREAD, Math.max(...births) + GRACE_MS).sort()).toEqual([103, 104]);
  });

  test('a parent pid taken by a younger process does not count as the parent', async () => {
    const sink = job.sink();
    sink.started(THREAD, 107, { exe: 'C:\\tools\\node.exe', commandLine: null, parentPid: 108 });
    await Bun.sleep(5);
    // Born after 107, so this 108 reuses the pid of the parent that exited.
    sink.started(THREAD, 108, { exe: 'C:\\tools\\git.exe', commandLine: null, parentPid: 100 });
    expect(procs.sweepOrphans(THREAD, Date.now() + 1000).sort()).toEqual([103, 104, 107]);
    expect(procs.liveOf(THREAD).some((record) => record.pid === 108)).toBe(true);
  });

  test('a process that takes a pid the thread already saw is followed, and its child stays', async () => {
    const sink = job.sink();
    await Bun.sleep(5);
    // The shell 102 exited in the setup. Windows hands its pid to a new shell,
    // which starts a dev server in the background.
    sink.started(THREAD, 102, { exe: 'C:\\tools\\bash.exe', commandLine: null, parentPid: 100 });
    sink.started(THREAD, 110, { exe: 'C:\\tools\\node.exe', commandLine: null, parentPid: 102 });
    expect(procs.liveOf(THREAD).map((record) => record.pid).sort()).toEqual([100, 101, 102, 103, 104, 105, 110]);

    bus.emit(...turn('turn.finished'));
    await waitFor(() => job.stopped.length === 2, 2000);
    await Bun.sleep(GRACE_MS * 2);
    // What the first 102 left behind still goes: the new 102 is younger than it.
    expect(job.stopped.sort()).toEqual([103, 104]);
    expect(procs.liveOf(THREAD).map((record) => record.pid).sort()).toEqual([100, 101, 102, 105, 110]);
  });

  test('a pid taken a second time is followed through its own exit', () => {
    const sink = job.sink();
    const exit = { exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
    sink.started(THREAD, 102, { exe: 'C:\\tools\\bash.exe', commandLine: null, parentPid: 100, startedAt: 5000 });
    sink.exited(THREAD, 102, exit);
    sink.started(THREAD, 102, { exe: 'C:\\tools\\pwsh.exe', commandLine: null, parentPid: 100, startedAt: 6000 });
    expect(procs.liveOf(THREAD).find((record) => record.pid === 102)).toMatchObject({ exe: 'C:\\tools\\pwsh.exe', startedAt: 6000 });
    expect(journal.listProcesses(THREAD, 50).filter((record) => record.pid === 102).map((record) => record.exe))
      .toContain('C:\\tools\\pwsh.exe');
  });

  test('a parent the registry never heard of but the system still runs keeps its child', () => {
    const sink = job.sink();
    sink.started(THREAD, 120, { exe: 'C:\\tools\\node.exe', commandLine: null, parentPid: 468, startedAt: 9000 });
    sink.started(THREAD, 121, { exe: 'C:\\tools\\node.exe', commandLine: null, parentPid: 120, startedAt: 9100 });
    // 468 runs since before 120 was created: it is the parent, whatever the registry missed.
    job.running.set(468, 8000);
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS).sort()).toEqual([103, 104]);

    // The same pid on a process created after 120: the parent left and its pid went to another.
    job.running.set(468, 9500);
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS).sort()).toEqual([120, 121]);
  });

  test('a start reported late for a process the core spawned is not a second process', () => {
    const threadId = 'late-start';
    const child = procs.spawnChild(threadId, process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: directory });
    const pid = child.pid as number;
    const born = procs.liveOf(threadId)[0]?.startedAt as number;
    expect(born).toBe(SPAWN_BORN);
    const started: number[] = [];
    const stop = bus.onAny((name, payload) => {
      if (name === 'process.started') started.push((payload as { pid: number }).pid);
    });
    // The job reports the core's own child, the same process: same pid, same creation.
    job.sink().started(threadId, pid, { exe: 'node', commandLine: null, parentPid: process.pid, startedAt: born });
    expect(started).toEqual([]);
    // One start per process: the next one under that pid is somebody else.
    procs.killTree(threadId);
    job.sink().exited(threadId, pid, { exitCode: 9, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
    job.sink().started(threadId, pid, { exe: 'C:\\tools\\git.exe', commandLine: null, parentPid: 100, startedAt: born + 50 });
    expect(started).toEqual([pid]);
    stop();
  });

  test('everything under an orphan goes with it, however deep, and a sibling tree stays', () => {
    const sink = job.sink();
    // A dev server whose watcher forked a chain of workers, the shell above it gone.
    const chain = Array.from({ length: 200 }, (_, index) => 1000 + index);
    for (const pid of chain) {
      sink.started(THREAD, pid, { exe: 'C:\\tools\\node.exe', commandLine: null, parentPid: pid === 1000 ? 999 : pid - 1 });
    }
    // Under the MCP server, whose parent is the live agent: never taken.
    sink.started(THREAD, 2000, { exe: 'C:\\tools\\node.exe', commandLine: null, parentPid: 101 });
    const stopped = procs.sweepOrphans(THREAD, Date.now() + GRACE_MS);
    expect(stopped.sort((a, b) => a - b)).toEqual([103, 104, ...chain]);
    expect(procs.liveOf(THREAD).map((record) => record.pid).sort((a, b) => a - b)).toEqual([100, 101, 105, 2000]);
  });

  test('a new turn inside the grace cancels the sweep', async () => {
    bus.emit(...turn('turn.finished'));
    bus.emit(...turn('turn.started'));
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    expect(job.stopped).toEqual([]);
  });

  test('a released agent schedules the same sweep with no turn to finish', async () => {
    procs.sweepSoon(THREAD);
    await waitFor(() => job.stopped.length === 2, 2000);
    expect(job.stopped.sort()).toEqual([103, 104]);
  });

  test('the setting turns it off', async () => {
    procs.applySettings({ ...DEFAULT_SETTINGS, reapOrphans: false });
    bus.emit(...turn('turn.finished'));
    procs.sweepSoon(THREAD);
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    expect(job.stopped).toEqual([]);
  });
});
