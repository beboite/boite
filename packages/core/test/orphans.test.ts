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

/** A job that reports what the test says and records what the registry stops. */
function fakeJob(): { platform: ProcessPlatform; sink: () => ProcessEventSink; stopped: number[] } {
  let events: ProcessEventSink | null = null;
  const stopped: number[] = [];
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
  };
  return {
    platform,
    stopped,
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
    expect(procs.sweepOrphans(THREAD, Date.now())).toEqual([]);
    expect(procs.sweepOrphans(THREAD, Date.now() + GRACE_MS).sort()).toEqual([103, 104]);
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

  test('a new turn inside the grace cancels the sweep', async () => {
    bus.emit(...turn('turn.finished'));
    bus.emit(...turn('turn.started'));
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    expect(job.stopped).toEqual([]);
  });

  test('the setting turns it off', async () => {
    procs.applySettings({ ...DEFAULT_SETTINGS, reapOrphans: false });
    bus.emit(...turn('turn.finished'));
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    expect(job.stopped).toEqual([]);
  });
});
