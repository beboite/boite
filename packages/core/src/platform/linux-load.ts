/**
 * A thread's load on Linux, read from procfs: CPU time from `/proc/<pid>/stat`
 * and resident memory from `/proc/<pid>/status`, summed over the thread's
 * registered processes. Those are the direct children only, what the registry
 * knows off Windows; what they started is not counted.
 *
 * No native code: the reader and the clock are given, so
 * `test/linux-load.test.ts` runs every case on fake files, on any platform.
 */
import { readFileSync } from 'node:fs';
import type { ProcessSample } from './types.ts';

/**
 * The unit of the stat file's CPU fields. The kernel fixes the value it exports
 * to user space at 100 on every architecture Boite runs on, whatever its own tick.
 */
export const USER_HZ = 100;

/** A procfs file's text, or null when the process is gone or the file cannot be read. */
export type ProcRead = (path: string) => string | null;

function readProc(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * utime plus stime, fields 14 and 15 of the stat line, in clock ticks. The
 * command name (field 2) sits in parentheses and may hold spaces or a `)`, so
 * the fields are counted from the last `)`.
 */
export function cpuTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // After ") ": field 3 (state) is index 0, so field n is index n - 3.
  const fields = stat.slice(close + 2).split(' ');
  const user = Number(fields[14 - 3]);
  const system = Number(fields[15 - 3]);
  if (!Number.isFinite(user) || !Number.isFinite(system)) return null;
  return user + system;
}

/** VmRSS of a status file in bytes, or null when the line is missing (a zombie has none). */
export function residentBytes(status: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match === null ? null : Number(match[1]) * 1024;
}

export class LinuxLoad {
  readonly #pids = new Map<string, Set<number>>();
  /** The thread's CPU ticks at its previous sample, per pid, and when that was. */
  readonly #last = new Map<string, { ticks: Map<number, number>; at: number }>();

  constructor(
    private readonly logicalCpus: number,
    private readonly read: ProcRead = readProc,
    private readonly now: () => number = Date.now,
  ) {}

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
    let processes = 0;
    for (const pid of pids) {
      const stat = this.read(`/proc/${pid}/stat`);
      const used = stat === null ? null : cpuTicks(stat);
      if (used === null) continue;
      processes += 1;
      ticks.set(pid, used);
      const status = this.read(`/proc/${pid}/status`);
      memoryBytes += (status === null ? null : residentBytes(status)) ?? 0;
    }
    if (processes === 0) return null;

    const at = this.now();
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
    return { processes, cpuPercent, memoryBytes };
  }
}
