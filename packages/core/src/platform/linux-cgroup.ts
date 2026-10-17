/**
 * A process's cgroup v2 memory readings on Linux: how often its group reached
 * `memory.high`, how long its processes waited for memory, the two limits and
 * the current charge.
 *
 * Past `memory.high` nothing fails. The kernel makes every process of the
 * group reclaim before it allocates, so they stall near 0 % CPU while the
 * `high` count of `memory.events` climbs. The count alone proves no stall: a
 * group full of clean page cache reaches the limit, the kernel drops cache and
 * nobody waits. The stall time of `memory.pressure` tells the two apart.
 *
 * No native code: both roots are given, so `test/linux-cgroup.test.ts` runs
 * every case on a temporary directory, on any platform.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CgroupMemory {
  /** The group's path under the cgroup root, as `/proc/<pid>/cgroup` names it. */
  path: string;
  /** Times the group was throttled at `memory.high` since it was created. */
  highEvents: number;
  /** Microseconds at least one process of the group waited for memory, since it was created. */
  stallMicros: number;
  highBytes: number;
  /** Null when `memory.max` is `max`, missing or unreadable: the hard limit is not what the notice is about. */
  maxBytes: number | null;
  currentBytes: number;
}

export interface CgroupRoots {
  proc?: string;
  cgroup?: string;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function count(text: string | null): number | null {
  const value = text?.trim() ?? '';
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * The unified hierarchy's line is `0::<path>`. A cgroup v1 file has none, and
 * a path outside this cgroup namespace starts with `/..`: neither can be read.
 */
export function cgroupPath(text: string): string | null {
  const path = /^0::(\/.*)$/m.exec(text)?.[1];
  if (path === undefined || path.split('/').includes('..')) return null;
  return path;
}

/** How long a group's path and limits are trusted before they are read again, so an admin change still lands. */
export const CGROUP_LIMITS_MS = 30_000;

/** What a process's group is and its two limits: fixed for a process unless an admin changes them. */
interface CgroupLimits {
  path: string;
  directory: string;
  /** Null when the group has no `memory.high`: there is nothing to read then. */
  highBytes: number | null;
  maxBytes: number | null;
}

function readLimits(pid: number, roots: CgroupRoots): CgroupLimits | null {
  const path = cgroupPath(read(join(roots.proc ?? '/proc', String(pid), 'cgroup')) ?? '');
  if (path === null) return null;
  const directory = join(roots.cgroup ?? '/sys/fs/cgroup', path);
  // `max` here means no throttling boundary, so the count below never moves.
  const highBytes = count(read(join(directory, 'memory.high')));
  if (highBytes === null) return { path, directory, highBytes, maxBytes: null };
  return { path, directory, highBytes, maxBytes: count(read(join(directory, 'memory.max'))) };
}

/** The three counters that move. Null when one is missing or malformed. */
function readCounters(limits: CgroupLimits): CgroupMemory | null {
  const { path, directory, highBytes, maxBytes } = limits;
  if (highBytes === null) return null;
  const highEvents = count(/^high (\d+)$/m.exec(read(join(directory, 'memory.events')) ?? '')?.[1] ?? null);
  const stallMicros = count(/^some .*\btotal=(\d+)$/m.exec(read(join(directory, 'memory.pressure')) ?? '')?.[1] ?? null);
  const currentBytes = count(read(join(directory, 'memory.current')));
  if (highEvents === null || stallMicros === null || currentBytes === null) return null;
  return { path, highEvents, stallMicros, highBytes, maxBytes, currentBytes };
}

/**
 * Null for a pid that is no process id, whenever a reading the notice needs is
 * missing or malformed, or the group has no `memory.high`. A kernel without pressure accounting has no
 * `memory.pressure`, so it gives null too: the count alone is never a reading.
 */
export function readCgroupMemory(pid: number, roots: CgroupRoots = {}): CgroupMemory | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const limits = readLimits(pid, roots);
  return limits === null ? null : readCounters(limits);
}

/**
 * `readCgroupMemory` for the load tick: each process's group and limits are
 * kept for `CGROUP_LIMITS_MS`, so a tick reads only the three counters. The
 * registry drops a process when it leaves (`forget`), so a reused pid starts over.
 */
export class CgroupMemoryReader {
  readonly #limits = new Map<number, { limits: CgroupLimits | null; at: number }>();

  constructor(private readonly roots: CgroupRoots = {}, private readonly now: () => number = Date.now) {}

  read(pid: number): CgroupMemory | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const at = this.now();
    let known = this.#limits.get(pid);
    if (known === undefined || at - known.at >= CGROUP_LIMITS_MS) {
      known = { limits: readLimits(pid, this.roots), at };
      this.#limits.set(pid, known);
    }
    if (known.limits === null) return null;
    const reading = readCounters(known.limits);
    // A group that went away, or a process that moved out of it: look it up again next time.
    if (reading === null && known.limits.highBytes !== null) this.#limits.delete(pid);
    return reading;
  }

  forget(pid: number): void {
    this.#limits.delete(pid);
  }
}
