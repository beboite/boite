import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
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
    sink.started(THREAD, 100, { exe: 'C:\\agent\\claude.exe', commandLine: null, parentPid: process.pid, startedAt: 1000 });
    sink.started(THREAD, 101, { exe: 'C:\\tools\\mcp.exe', commandLine: null, parentPid: 100, startedAt: 2000 });
    sink.started(THREAD, 102, { exe: 'C:\\Windows\\cmd.exe', commandLine: null, parentPid: 100, startedAt: 3000 });
    sink.started(THREAD, 103, { exe: 'C:\\tools\\bun.exe', commandLine: null, parentPid: 102, startedAt: 4000 });
    sink.started(THREAD, 104, { exe: 'C:\\tools\\chrome.exe', commandLine: null, parentPid: 103, startedAt: 4500 });
    sink.started(THREAD, 105, { exe: 'C:\\tools\\unknown.exe', commandLine: null, parentPid: null, startedAt: 4600 });
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
    const terminate = spyOn(job.platform, 'terminateProcess');
    try {
      bus.emit(...turn('turn.finished'));
      await waitFor(() => job.stopped.length === 2, 2000);
      expect(job.stopped.sort()).toEqual([103, 104]);
      expect(terminate.mock.calls).toEqual([[THREAD, 103, 4000], [THREAD, 104, 4500]]);
      expect(procs.liveOf(THREAD).map((record) => record.pid).sort()).toEqual([100, 101, 105]);
    } finally { terminate.mockRestore(); }
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
    sink.started(THREAD, 102, { exe: 'C:\\tools\\bash.exe', commandLine: null, parentPid: 100, startedAt: 5000 });
    sink.started(THREAD, 110, { exe: 'C:\\tools\\node.exe', commandLine: null, parentPid: 102, startedAt: 5100 });
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

  test('a start reported late for a process the core spawned is not a second process', async () => {
    const threadId = 'late-start';
    // On Windows the child's own kill waits for taskkill, tens to hundreds of
    // ms: held here, so the child still runs, in this test's directory, when
    // the test ends. The directory cannot be removed before it exits (EBUSY).
    const treeKill = spyOn(job.platform, 'terminateUnassigned').mockImplementation(() => Bun.sleep(300));
    const child = procs.spawnChild(threadId, process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: directory });
    const exited = new Promise(resolve => child.once('exit', resolve));
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
    treeKill.mockRestore();
    await exited;
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

  test('a script under a background shell that still runs outlives the fork stubs Git Bash left exited', () => {
    const sink = job.sink();
    const exit = { exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
    const born = Date.now() - 1000;
    const bash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    const sh = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe';
    // `sh wait.sh` run in the background, as the trace shows it: Git's launcher
    // starts the MSYS bash, which forks a copy of itself to exec the script.
    // That copy exits once the script runs, and the script's own fork for
    // `sleep` does the same.
    sink.started(THREAD, 130, { exe: 'C:\\Program Files\\Git\\bin\\bash.exe', commandLine: null, parentPid: 100, startedAt: born });
    sink.started(THREAD, 131, { exe: bash, commandLine: null, parentPid: 130, startedAt: born + 10 });
    sink.started(THREAD, 132, { exe: bash, commandLine: null, parentPid: 131, startedAt: born + 20 });
    sink.started(THREAD, 133, { exe: sh, commandLine: null, parentPid: 132, startedAt: born + 30 });
    sink.exited(THREAD, 132, exit);
    sink.started(THREAD, 134, { exe: sh, commandLine: null, parentPid: 133, startedAt: born + 40 });
    sink.started(THREAD, 135, { exe: 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe', commandLine: null, parentPid: 134, startedAt: born + 50 });
    // An exit event can arrive seconds late: the sweep reads no timing.
    const late = Date.now() + 6000;
    setSystemTime(late);
    try { sink.exited(THREAD, 134, exit); } finally { setSystemTime(); }
    expect(procs.sweepOrphans(THREAD, late + GRACE_MS).sort()).toEqual([103, 104]);

    // The task's shell goes, though its launcher stays: the script is an orphan now.
    sink.exited(THREAD, 131, exit);
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS).sort()).toEqual([133, 135]);
  });

  test('what an orphan shell ran through a fork stub goes with it', () => {
    const sink = job.sink();
    const exit = { exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
    const born = Date.now() - 1000;
    const bash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    // An interrupted command: the launcher goes, its MSYS bash and the sleep it forked stay.
    sink.started(THREAD, 140, { exe: 'C:\\Program Files\\Git\\bin\\bash.exe', commandLine: null, parentPid: 100, startedAt: born });
    sink.started(THREAD, 141, { exe: bash, commandLine: null, parentPid: 140, startedAt: born + 10 });
    sink.started(THREAD, 142, { exe: bash, commandLine: null, parentPid: 141, startedAt: born + 20 });
    sink.started(THREAD, 143, { exe: 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe', commandLine: null, parentPid: 142, startedAt: born + 30 });
    sink.exited(THREAD, 142, exit);
    sink.exited(THREAD, 140, exit);
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS).sort()).toEqual([103, 104, 141, 143]);
  });

  test('an exited parent of the same image that is no shell fork leaves an orphan', () => {
    const sink = job.sink();
    const node = 'C:\\tools\\node.exe';
    // A live Node service whose worker started a detached process and quit.
    sink.started(THREAD, 160, { exe: node, commandLine: null, parentPid: 100, startedAt: 5000 });
    sink.started(THREAD, 161, { exe: node, commandLine: null, parentPid: 160, startedAt: 5010 });
    sink.started(THREAD, 162, { exe: node, commandLine: null, parentPid: 161, startedAt: 5020 });
    sink.exited(THREAD, 161, { exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS).sort()).toEqual([103, 104, 162]);
  });

  test('the sleep of a nested bash that was stopped, or exited with 0, is an orphan under the live outer bash', () => {
    const sink = job.sink();
    const bash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    const sleep = 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe';
    const exit = (exitCode: number) => ({ exitCode, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
    // A live bash whose inner bash loops on `sleep infinity`, each sleep exec'd by a fork.
    const nested = (first: number, born: number) => {
      sink.started(THREAD, first, { exe: bash, commandLine: null, parentPid: 100, startedAt: born });
      sink.started(THREAD, first + 1, { exe: bash, commandLine: null, parentPid: first, startedAt: born + 10 });
      sink.started(THREAD, first + 2, { exe: bash, commandLine: null, parentPid: first + 1, startedAt: born + 20 });
      sink.started(THREAD, first + 3, { exe: sleep, commandLine: null, parentPid: first + 2, startedAt: born + 30 });
      sink.exited(THREAD, first + 2, exit(0));
    };
    const now = Date.now();
    nested(170, now - 1000);
    nested(180, now - 1000);
    expect(procs.sweepOrphans(THREAD, now + GRACE_MS).sort()).toEqual([103, 104]);

    // One inner bash is stopped while its sleep runs, the other exits with 0
    // at once: two exited processes above each sleep, the fork and that bash.
    sink.exited(THREAD, 171, exit(1));
    sink.exited(THREAD, 181, exit(0));
    expect(procs.sweepOrphans(THREAD, now + GRACE_MS).sort()).toEqual([173, 183]);
  });

  test('a subshell left by a subshell that trapped TERM is kept while the bash above runs, then goes', () => {
    const sink = job.sink();
    const bash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    const exit = { exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
    const born = Date.now() - 1000;
    // `( trap 'exit 0' TERM; ( read ) & wait ) &`, the middle one stopped by
    // TERM: from Windows it is a fork that exited with 0, so its child stays.
    sink.started(THREAD, 190, { exe: bash, commandLine: null, parentPid: 100, startedAt: born });
    sink.started(THREAD, 191, { exe: bash, commandLine: null, parentPid: 190, startedAt: born + 10 });
    sink.started(THREAD, 192, { exe: bash, commandLine: null, parentPid: 191, startedAt: born + 20 });
    sink.exited(THREAD, 191, exit);
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS).sort()).toEqual([103, 104]);

    // The first sweep after that bash exits takes it.
    sink.exited(THREAD, 190, exit);
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS)).toEqual([192]);
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
