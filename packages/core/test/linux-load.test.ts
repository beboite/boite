import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { cpuTicks, LinuxLoad, residentBytes, USER_HZ } from '../src/platform/linux-load.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { ProcRegistry } from '../src/procs.ts';
import { waitFor } from './harness.ts';

/** A stat line as the kernel writes it, with a command name that fights back. */
function stat(pid: number, utime: number, stime: number, comm = 'node'): string {
  const after = ['S', '1', String(pid), String(pid), '0', '-1', '4194560', '100', '0', '0', '0', String(utime), String(stime), '0', '0', '20', '0', '1'];
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
  test('CPU fields are counted from the last parenthesis, whatever the command name holds', () => {
    expect(cpuTicks(stat(7, 120, 30))).toBe(150);
    expect(cpuTicks(stat(7, 5, 6, 'a) b (c'))).toBe(11);
    expect(cpuTicks('7 (truncated')).toBeNull();
  });

  test('resident memory is VmRSS in bytes, and a zombie without the line has none', () => {
    expect(residentBytes(status(2048))).toBe(2048 * 1024);
    expect(residentBytes(status(null))).toBeNull();
  });
});

describe('a thread load on Linux', () => {
  test('CPU is the ticks spent since the previous sample over the whole machine, memory is summed', () => {
    const proc = new FakeProc();
    const load = new LinuxLoad(4, proc.read, proc.now);
    load.add('thr', 100);
    load.add('thr', 101);
    proc.set(100, 1000, 200, 50_000);
    proc.set(101, 10, 0, 30_000);

    expect(load.sample('thr')).toEqual({ processes: 2, cpuPercent: 0, memoryBytes: 80_000 * 1024 });

    // One second later: 2 cores busy on pid 100, idle on 101.
    proc.at += 1000;
    proc.set(100, 1000 + 2 * USER_HZ, 200, 60_000);
    expect(load.sample('thr')).toEqual({ processes: 2, cpuPercent: 50, memoryBytes: 90_000 * 1024 });
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
    expect(load.sample('thr')).toEqual({ processes: 1, cpuPercent: 0, memoryBytes: 2000 * 1024 });

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
  const proc = new FakeProc();

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'boite-linux-load-'));
    previousDataDir = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    journal = new Journal(join(directory, 'journal.db'));
    procs = new ProcRegistry(journal, new Bus(), createPosixPlatform('linux', new LinuxLoad(2, proc.read, proc.now)));
  });

  afterEach(async () => {
    procs.killAll();
    await waitFor(() => procs.liveCount('busy') === 0);
    await procs.close();
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
});
