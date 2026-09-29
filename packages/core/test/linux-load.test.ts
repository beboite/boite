import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { cpuTicks, LinuxLoad, linuxMachineMemory, linuxStartedAt, residentBytes, USER_HZ } from '../src/platform/linux-load.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { ProcRegistry } from '../src/procs.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { waitFor } from './harness.ts';

/** A stat line as the kernel writes it, with a command name that fights back. */
function stat(pid: number, utime: number, stime: number, comm = 'node', parentPid = 1): string {
  const after = ['S', String(parentPid), String(pid), String(pid), '0', '-1', '4194560', '100', '0', '0', '0', String(utime), String(stime), '0', '0', '20', '0', '1'];
  return `${pid} (${comm}) ${after.join(' ')}\n`;
}

function status(rssKb: number | null): string {
  return ['Name:\tnode', 'State:\tS (sleeping)', ...(rssKb === null ? [] : [`VmRSS:\t  ${rssKb} kB`]), 'Threads:\t7', ''].join('\n');
}

/** A procfs of fake files the test rewrites between samples. */
class FakeProc {
  readonly files = new Map<string, string>();
  at = 1_000_000;

  set(pid: number, utime: number, stime: number, rssKb: number | null, comm?: string): void {
    this.files.set(`/proc/${pid}/stat`, stat(pid, utime, stime, comm));
    this.files.set(`/proc/${pid}/status`, status(rssKb));
  }

  gone(pid: number): void {
    this.files.delete(`/proc/${pid}/stat`);
    this.files.delete(`/proc/${pid}/status`);
  }

  readonly read = (path: string): string | null => this.files.get(path) ?? null;
  readonly now = (): number => this.at;
}

describe('the procfs parsers', () => {
  test('machine memory uses MemAvailable, which includes reclaimable pages', () => {
    const read = (path: string) => path === '/proc/meminfo'
      ? 'MemTotal:       8388608 kB\nMemFree:         131072 kB\nMemAvailable:  4194304 kB\n'
      : null;
    expect(linuxMachineMemory(read)).toEqual({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 });
  });

  test('machine memory is unknown when procfs is missing or incomplete', () => {
    expect(linuxMachineMemory(() => null)).toBeNull();
    expect(linuxMachineMemory(() => 'MemTotal: 8388608 kB\nMemFree: 131072 kB\n')).toBeNull();
    expect(linuxMachineMemory(() => 'MemAvailable: 4194304 kB\n')).toBeNull();
  });

  test('CPU fields are counted from the last parenthesis, whatever the command name holds', () => {
    expect(cpuTicks(stat(7, 120, 30))).toBe(150);
    expect(cpuTicks(stat(7, 5, 6, 'a) b (c'))).toBe(11);
    expect(cpuTicks('7 (truncated')).toBeNull();
  });

  test('resident memory is VmRSS in bytes, and a zombie without the line has none', () => {
    expect(residentBytes(status(2048))).toBe(2048 * 1024);
    expect(residentBytes(status(null))).toBeNull();
  });

  test('a start time is the boot time plus field 22 in ticks, and a gone process has none', () => {
    // Fields 3 to 21 as the kernel writes them, then starttime, then the rest cut short.
    const fields = ['S', '1', '42', '42', '0', '-1', '4194560', '100', '0', '0', '0', '7', '3', '0', '0', '20', '0', '1', '0', '12345', '99999'];
    const files = new Map([
      ['/proc/42/stat', `42 (a) b (c) ${fields.join(' ')}\n`],
      ['/proc/stat', 'cpu  1 2 3 4\nbtime 1790500000\nprocesses 900\n'],
    ]);
    const read = (path: string): string | null => files.get(path) ?? null;
    expect(linuxStartedAt(42, read)).toBe(1_790_500_000_000 + (12345 * 1000) / USER_HZ);
    expect(linuxStartedAt(43, read)).toBeNull();
    expect(linuxStartedAt(0, read)).toBeNull();
  });
});

describe('a thread load on Linux', () => {
  test('one parent snapshot supplies stat reads across threads and refreshes after 500 ms', () => {
    const proc = new FakeProc();
    proc.files.set('/proc', '100 101 200');
    proc.set(100, 10, 0, 1000);
    proc.set(200, 10, 0, 2000);
    proc.files.set('/proc/101/stat', stat(101, 10, 0, 'child', 100));
    proc.files.set('/proc/101/status', status(3000));
    const reads: string[] = [];
    const load = new LinuxLoad(2, path => { reads.push(path); return proc.read(path); }, proc.now);
    load.add('first', 100);
    load.add('second', 200);
    expect(load.sample('first')?.processes).toBe(2);
    expect(load.sample('second')?.processes).toBe(1);
    expect(reads.filter(path => path === '/proc')).toHaveLength(1);
    expect(reads.filter(path => path.endsWith('/stat'))).toHaveLength(3);
    expect(reads.some(path => path.includes('/task'))).toBe(false);
    proc.files.set('/proc', '100 101 102 200');
    proc.files.set('/proc/102/stat', stat(102, 10, 0, 'new-child', 100));
    proc.files.set('/proc/102/status', status(4000));
    proc.at += 499;
    expect(load.sample('first')?.processes).toBe(2);
    proc.at += 1;
    expect(load.sample('first')?.processes).toBe(3);
    expect(reads.filter(path => path === '/proc')).toHaveLength(2);
  });

  test('a newly registered root absent from the cached scan is still sampled, and a vanished root is skipped', () => {
    const proc = new FakeProc();
    proc.files.set('/proc', '100');
    proc.set(100, 10, 0, 1000);
    const load = new LinuxLoad(2, proc.read, proc.now);
    load.add('first', 100);
    expect(load.sample('first')?.processes).toBe(1);
    proc.set(200, 10, 0, 2000);
    load.add('new', 200);
    expect(load.sample('new')?.memoryBytes).toBe(2000 * 1024);
    proc.gone(100);
    expect(load.sample('first')).toBeNull();
  });

  test('a vanished cached child does not hide its surviving sibling', () => {
    const proc = new FakeProc();
    proc.files.set('/proc', '100 101 102');
    proc.set(100, 10, 0, 1000);
    for (const pid of [101, 102]) {
      proc.files.set(`/proc/${pid}/stat`, stat(pid, 10, 0, 'child', 100));
      proc.files.set(`/proc/${pid}/status`, status(2000));
    }
    const load = new LinuxLoad(2, proc.read, proc.now);
    load.add('thr', 100);
    expect(load.sample('thr')?.processes).toBe(3);
    proc.gone(101);
    expect(load.sample('thr')).toMatchObject({ processes: 2, memoryBytes: 3000 * 1024 });
  });

  test('killTree refreshes the parent scan and keeps children discovered only through another task', () => {
    const proc = new FakeProc();
    proc.files.set('/proc', '100');
    proc.set(100, 10, 0, 1000);
    const signalled: number[] = [];
    const load = new LinuxLoad(2, proc.read, proc.now, pid => { signalled.push(pid); });
    load.add('thr', 100);
    load.sample('thr');
    proc.files.set('/proc', '100 101');
    proc.files.set('/proc/101/stat', stat(101, 10, 0, 'child', 100));
    proc.files.set('/proc/100/task', '100 110');
    proc.files.set('/proc/100/task/110/children', '102');
    proc.files.set('/proc/102/task/102/children', '103');
    expect(load.killTree(100)).toBe(true);
    expect(signalled.sort()).toEqual([100, 101, 102, 103]);
  });

  test('counts children from every task and grandchildren once, with their executable names', () => {
    const proc = new FakeProc();
    const load = new LinuxLoad(2, proc.read, proc.now);
    load.add('thr', 100);
    proc.set(100, 10, 0, 1000);
    proc.set(101, 20, 0, 2000);
    proc.set(102, 30, 0, 3000);
    proc.files.set('/proc/100/task', '100\n110');
    proc.files.set('/proc/100/task/100/children', '');
    proc.files.set('/proc/100/task/110/children', '101 ');
    proc.files.set('/proc/101/task/101/children', '102 ');
    proc.files.set('/proc/102/task/102/children', '');
    proc.files.set('/proc/100/comm', 'agent\n');
    proc.files.set('/proc/101/comm', 'cargo\n');
    proc.files.set('/proc/102/comm', 'rustc\n');

    expect(load.sample('thr')).toEqual({ processes: 3, cpuPercent: 0, memoryBytes: 6000 * 1024, workingSets: [
      { pid: 100, bytes: 1000 * 1024, exe: 'agent' },
      { pid: 101, bytes: 2000 * 1024, exe: 'cargo' },
      { pid: 102, bytes: 3000 * 1024, exe: 'rustc' },
    ] });
    load.add('thr', 101);
    expect(load.sample('thr')).toMatchObject({ processes: 3, memoryBytes: 6000 * 1024 });
  });

  test('missing children files fall back to stat parent pids without counting unrelated processes', () => {
    const proc = new FakeProc();
    const load = new LinuxLoad(2, proc.read, proc.now);
    load.add('thr', 100);
    proc.files.set('/proc', '100\n101\n102\n200\nmeminfo');
    for (const [pid, parent, exe] of [[100, 1, 'agent'], [101, 100, 'a) b (c'], [102, 101, 'rustc'], [200, 1, 'other']] as const) {
      proc.set(pid, 10, 0, 1000);
      proc.files.set(`/proc/${pid}/stat`, stat(pid, 10, 0, exe, parent));
      proc.files.set(`/proc/${pid}/comm`, `${exe}\n`);
    }

    expect(load.sample('thr')).toEqual({ processes: 3, cpuPercent: 0, memoryBytes: 3000 * 1024, workingSets: [
      { pid: 100, bytes: 1000 * 1024, exe: 'agent' },
      { pid: 101, bytes: 1000 * 1024, exe: 'a) b (c' },
      { pid: 102, bytes: 1000 * 1024, exe: 'rustc' },
    ] });
  });

  test('a pid vanishing during the walk does not hide its surviving sibling', () => {
    const proc = new FakeProc();
    proc.set(100, 10, 0, 1000);
    proc.set(101, 10, 0, 2000);
    proc.set(102, 10, 0, 3000);
    proc.files.set('/proc/100/task/100/children', '101 102');
    proc.files.set('/proc/102/comm', 'cargo\n');
    const load = new LinuxLoad(2, path => {
      if (path === '/proc/101/stat') proc.gone(101);
      return proc.read(path);
    }, proc.now);
    load.add('thr', 100);

    expect(load.sample('thr')).toMatchObject({ processes: 2, memoryBytes: 4000 * 1024 });
    expect(load.sample('thr')?.workingSets).toContainEqual({ pid: 102, bytes: 3000 * 1024, exe: 'cargo' });
  });

  test('a child missing from a readable children file still counts through the parent scan', () => {
    const proc = new FakeProc();
    proc.set(100, 10, 0, 1000);
    proc.files.set('/proc/101/stat', stat(101, 10, 0, 'cc', 100));
    proc.files.set('/proc/101/status', status(2000));
    proc.files.set('/proc/102/stat', stat(102, 10, 0, 'rustc', 100));
    proc.files.set('/proc/102/status', status(5000));
    proc.files.set('/proc', '100 101 102 self');
    proc.files.set('/proc/100/task/100/children', '101');
    const load = new LinuxLoad(2, proc.read, proc.now);
    load.add('thr', 100);

    expect(load.sample('thr')).toMatchObject({ processes: 3, memoryBytes: 8000 * 1024 });
  });

  test('stopping a descendant signals its own children too, and fails only when it cannot be signalled', () => {
    const proc = new FakeProc();
    proc.files.set('/proc/42/stat', stat(42, 10, 0, 'cargo', 100));
    proc.files.set('/proc/43/stat', stat(43, 10, 0, 'rustc', 42));
    proc.files.set('/proc/44/stat', stat(44, 10, 0, 'cc', 43));
    proc.files.set('/proc', '42 43 44');
    const signalled: number[] = [];
    const load = new LinuxLoad(2, proc.read, proc.now, pid => {
      if (pid === 7) throw new Error('ESRCH');
      signalled.push(pid);
    });

    expect(load.killTree(42)).toBe(true);
    expect(signalled.sort()).toEqual([42, 43, 44]);
    expect(load.killTree(7)).toBe(false);
  });

  test('CPU is the ticks spent since the previous sample over the whole machine, memory is summed', () => {
    const proc = new FakeProc();
    const load = new LinuxLoad(4, proc.read, proc.now);
    load.add('thr', 100);
    load.add('thr', 101);
    proc.set(100, 1000, 200, 50_000);
    proc.set(101, 10, 0, 30_000);

    expect(load.sample('thr')).toEqual({ processes: 2, cpuPercent: 0, memoryBytes: 80_000 * 1024, workingSets: [{ pid: 100, bytes: 50_000 * 1024 }, { pid: 101, bytes: 30_000 * 1024 }] });

    // One second later: 2 cores busy on pid 100, idle on 101.
    proc.at += 1000;
    proc.set(100, 1000 + 2 * USER_HZ, 200, 60_000);
    expect(load.sample('thr')).toEqual({ processes: 2, cpuPercent: 50, memoryBytes: 90_000 * 1024, workingSets: [{ pid: 100, bytes: 60_000 * 1024 }, { pid: 101, bytes: 30_000 * 1024 }] });
  });

  test('a pid that exited between samples is skipped, and one read the first time adds no CPU', () => {
    const proc = new FakeProc();
    const load = new LinuxLoad(1, proc.read, proc.now);
    load.add('thr', 200);
    load.add('thr', 201);
    proc.set(200, 500, 0, 1000);
    load.sample('thr');

    proc.at += 1000;
    proc.gone(200);
    proc.set(201, 9000, 0, 2000);
    expect(load.sample('thr')).toEqual({ processes: 1, cpuPercent: 0, memoryBytes: 2000 * 1024, workingSets: [{ pid: 201, bytes: 2000 * 1024 }] });

    proc.gone(201);
    expect(load.sample('thr')).toBeNull();
    load.remove('thr', 200);
    load.remove('thr', 201);
    expect(load.sample('thr')).toBeNull();
  });
});

describe('the registry on the Linux backend', () => {
  let directory: string;
  let previousDataDir: string | undefined;
  let journal: Journal;
  let procs: ProcRegistry;
  let bus: Bus;
  const proc = new FakeProc();

  beforeEach(() => {
    proc.files.clear();
    directory = mkdtempSync(join(tmpdir(), 'boite-linux-load-'));
    previousDataDir = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    journal = new Journal(join(directory, 'journal.db'));
    bus = new Bus();
    procs = new ProcRegistry(journal, bus, createPosixPlatform('linux', new LinuxLoad(2, proc.read, proc.now)));
  });

  afterEach(async () => {
    await procs.killAll();
    await waitFor(() => procs.liveCount('busy') === 0);
    await procs.close();
    bus.dispose();
    journal.close();
    if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
    else process.env.BOITE_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test('a running child shows its memory in the thread load instead of 0 B', () => {
    const child = procs.spawn('busy', process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: directory });
    proc.set(child.record.pid, 40, 10, 64_000);
    expect(procs.loadOf('busy')).toEqual({ processes: 1, cpuPercent: 0, memoryBytes: 64_000 * 1024 });
  });

  test('the memory governor kills a sampled descendant alone and protects the registered root', () => {
    const child = procs.spawn('busy', process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: directory });
    const pid = child.record.pid;
    proc.set(pid, 10, 0, 900 * 1024);
    proc.set(42, 10, 0, 800 * 1024);
    proc.files.set(`/proc/${pid}/task/${pid}/children`, '42');
    proc.files.set('/proc/42/comm', 'cargo\n');
    procs.applySettings({ ...DEFAULT_SETTINGS, threadMemoryCapMb: 1024 });
    const events: unknown[] = [];
    bus.onAny((name, payload) => {
      if (name === 'resources.memory') events.push(payload);
    });
    const kill = spyOn(process, 'kill').mockReturnValue(true);
    try {
      (procs as unknown as { sampleLoad(): void }).sampleLoad();
      expect(procs.memory.status().agentBytes).toBe(1700 * 1024 ** 2);
      expect(kill.mock.calls).toEqual([[42, 'SIGKILL']]);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'killed', pid: 42, exe: 'cargo', reason: 'thread-quota' }));
      expect(child.proc.exitCode).toBeNull();
      expect(procs.liveCount('busy')).toBe(1);
    } finally {
      kill.mockRestore();
    }
  });
});
