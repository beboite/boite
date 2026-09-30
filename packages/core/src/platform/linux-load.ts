/**
 * A thread's load on Linux, read from procfs: CPU time from `/proc/<pid>/stat`
 * and resident memory from `/proc/<pid>/status`, summed over the thread's
 * registered processes and their descendants. The same stat line also
 * says when a process started, which the data directory lock asks.
 *
 * No native code: the reader and the clock are given, so
 * `test/linux-load.test.ts` runs every case on fake files, on any platform.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { ProcessPlatform, ProcessSample } from './types.ts';

/**
 * The unit of the stat file's CPU fields. The kernel fixes the value it exports
 * to user space at 100 on every architecture Boite runs on, whatever its own tick.
 */
export const USER_HZ = 100;

/** File text or newline-separated directory entries; null when gone or unreadable. */
export type ProcRead = (path: string) => string | null;

function readProc(path: string): string | null {
  try {
    if (path === '/proc' || path.endsWith('/task')) return readdirSync(path).join('\n');
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** MemAvailable includes reclaimable pages; MemFree alone understates what agents can use. */
export function linuxMachineMemory(read: ProcRead = readProc): ReturnType<ProcessPlatform['machineMemory']> {
  const info = read('/proc/meminfo') ?? '';
  const total = /^MemTotal:\s+(\d+)\s+kB$/m.exec(info);
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
  if (total === null || available === null) return null;
  return { totalBytes: Number(total[1]) * 1024, availableBytes: Number(available[1]) * 1024 };
}

/**
 * The numbered field of a stat line. The command name (field 2) sits in
 * parentheses and may hold spaces or a `)`, so the fields are counted from the
 * last `)`.
 */
function statField(stat: string, field: number): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // After ") ": field 3 (state) is index 0, so field n is index n - 3.
  const value = Number(stat.slice(close + 2).split(' ')[field - 3]);
  return Number.isFinite(value) ? value : null;
}

/** utime plus stime, fields 14 and 15 of the stat line, in clock ticks. */
export function cpuTicks(stat: string): number | null {
  const user = statField(stat, 14);
  const system = statField(stat, 15);
  if (user === null || system === null) return null;
  return user + system;
}

/**
 * When the process that holds `pid` started, in ms since the epoch: its stat
 * line's field 22, in clock ticks after boot, plus the boot time `/proc/stat`
 * gives in whole seconds. Null when the process is gone.
 */
export function linuxStartedAt(pid: number, read: ProcRead = readProc): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const stat = read(`/proc/${pid}/stat`);
  const ticks = stat === null ? null : statField(stat, 22);
  const boot = /^btime\s+(\d+)$/m.exec(read('/proc/stat') ?? '');
  if (ticks === null || boot === null) return null;
  return Number(boot[1]) * 1000 + Math.round((ticks * 1000) / USER_HZ);
}

/** VmRSS of a status file in bytes, or null when the line is missing (a zombie has none). */
export function residentBytes(status: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match === null ? null : Number(match[1]) * 1024;
}

function pidsIn(text: string): number[] {
  return text.split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0);
}

interface ProcSnapshot {
  at: number;
  children: Map<number, number[]>;
  stats: Map<number, string>;
  available: boolean;
}

/** Parent links and raw stat lines from the same procfs walk. */
function scanProc(read: ProcRead): Omit<ProcSnapshot, 'at'> {
  const children = new Map<number, number[]>();
  const stats = new Map<number, string>();
  const directory = read('/proc');
  for (const pid of pidsIn(directory ?? '')) {
    const stat = read(`/proc/${pid}/stat`);
    if (stat !== null) stats.set(pid, stat);
    const parent = stat === null ? null : statField(stat, 4);
    if (parent === null) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  return { children, stats, available: directory !== null };
}

export class LinuxLoad {
  readonly #pids = new Map<string, Set<number>>();
  /** The thread's CPU ticks at its previous sample, per pid, and when that was. */
  readonly #last = new Map<string, { ticks: Map<number, number>; at: number }>();
  /** One parent scan serves every thread sampled in the same tick. */
  #scan: ProcSnapshot | null = null;

  constructor(
    private readonly logicalCpus: number,
    private readonly read: ProcRead = readProc,
    private readonly now: () => number = Date.now,
    private readonly signal: (pid: number) => void = (pid) => { process.kill(pid, 'SIGKILL'); },
  ) {}

  #snapshot(fresh = false): ProcSnapshot {
    const at = this.now();
    if (fresh || this.#scan === null || at - this.#scan.at >= 500) this.#scan = { at, ...scanProc(this.read) };
    return this.#scan;
  }

  /** Killing always adds each task's current children to the fresh parent scan. */
  #children(pid: number, scan: ProcSnapshot, tasks = false): number[] {
    const found = new Set(scan.children.get(pid) ?? []);
    if (scan.available && !tasks) return [...found];
    for (const tid of pidsIn(this.read(`/proc/${pid}/task`) ?? String(pid))) {
      for (const child of pidsIn(this.read(`/proc/${pid}/task/${tid}/children`) ?? '')) found.add(child);
    }
    return [...found];
  }

  /**
   * Stop one process and everything under it. Its children would be reparented
   * away from the thread's roots and drop out of the next sample while still
   * holding their memory. False when the process itself could not be signalled.
   */
  killTree(pid: number): boolean {
    const scan = this.#snapshot(true);
    const tree = new Set([pid]);
    for (const member of tree) for (const child of this.#children(member, scan, true)) tree.add(child);
    let stopped = false;
    for (const member of tree) {
      try {
        this.signal(member);
        if (member === pid) stopped = true;
      } catch {
        // Already gone, or not ours to signal.
      }
    }
    return stopped;
  }

  add(threadId: string, pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    let pids = this.#pids.get(threadId);
    if (pids === undefined) {
      pids = new Set();
      this.#pids.set(threadId, pids);
    }
    pids.add(pid);
  }

  remove(threadId: string, pid: number): void {
    const pids = this.#pids.get(threadId);
    if (pids === undefined) return;
    pids.delete(pid);
    if (pids.size > 0) return;
    this.#pids.delete(threadId);
    this.#last.delete(threadId);
  }

  /**
   * CPU as a share of the whole machine since the previous sample, and resident
   * memory now. Null when no process of the thread could be read at all. The
   * first sample of a thread has no interval yet, so its CPU reads 0.
   */
  sample(threadId: string): ProcessSample | null {
    const pids = this.#pids.get(threadId);
    if (pids === undefined) return null;
    const ticks = new Map<number, number>();
    let memoryBytes = 0;
    const workingSets: NonNullable<ProcessSample['workingSets']> = [];
    let processes = 0;
    const scan = this.#snapshot();
    const at = this.now();
    const pending = new Set(pids);
    for (const pid of pending) {
      const status = this.read(`/proc/${pid}/status`);
      // Topology can be shared for 500 ms, but CPU ticks must describe this
      // sample's time. Reuse scan reads only at that same time, and confirm a
      // process whose status vanished instead of counting its cached stat.
      const stat = scan.at === at && status !== null
        ? scan.stats.get(pid) ?? this.read(`/proc/${pid}/stat`)
        : this.read(`/proc/${pid}/stat`);
      const used = stat === null ? null : cpuTicks(stat);
      if (used === null) continue;
      processes += 1;
      ticks.set(pid, used);
      const bytes = status === null ? null : residentBytes(status);
      const exe = this.read(`/proc/${pid}/comm`)?.trim();
      if (bytes !== null) workingSets.push({ pid, bytes, ...(exe ? { exe } : {}) });
      memoryBytes += bytes ?? 0;
      for (const child of this.#children(pid, scan)) pending.add(child);
    }
    if (processes === 0) return null;

    const previous = this.#last.get(threadId);
    this.#last.set(threadId, { ticks, at });
    let cpuPercent = 0;
    const elapsedMs = previous === undefined ? 0 : at - previous.at;
    if (previous !== undefined && elapsedMs > 0) {
      // Per pid, so a process that exited or started in between moves nothing.
      let spent = 0;
      for (const [pid, now] of ticks) {
        const before = previous.ticks.get(pid);
        if (before !== undefined && now >= before) spent += now - before;
      }
      const cpuMs = (spent * 1000) / USER_HZ;
      cpuPercent = Math.round((cpuMs / (elapsedMs * Math.max(1, this.logicalCpus))) * 1000) / 10;
    }
    return { processes, cpuPercent, memoryBytes, workingSets };
  }
}
