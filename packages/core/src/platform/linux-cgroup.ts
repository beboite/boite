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
  /** Null when `memory.max` is `max`: the group is throttled but never refused. */
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

/**
 * Null whenever any reading is missing, the group has no `memory.high`, or the
 * files are unreadable. A kernel without pressure accounting has no
 * `memory.pressure`, so it gives null too: the count alone is never a reading.
 */
export function readCgroupMemory(pid: number, roots: CgroupRoots = {}): CgroupMemory | null {
  const path = cgroupPath(read(join(roots.proc ?? '/proc', String(pid), 'cgroup')) ?? '');
  if (path === null) return null;
  const directory = join(roots.cgroup ?? '/sys/fs/cgroup', path);
  // `max` here means no throttling boundary, so the count below never moves.
  const highBytes = count(read(join(directory, 'memory.high')));
  if (highBytes === null) return null;
  const highEvents = count(/^high (\d+)$/m.exec(read(join(directory, 'memory.events')) ?? '')?.[1] ?? null);
  const stallMicros = count(/^some .*\btotal=(\d+)$/m.exec(read(join(directory, 'memory.pressure')) ?? '')?.[1] ?? null);
  const currentBytes = count(read(join(directory, 'memory.current')));
  const max = read(join(directory, 'memory.max'))?.trim();
  if (highEvents === null || stallMicros === null || currentBytes === null || max === undefined) return null;
  const maxBytes = max === 'max' ? null : count(max);
  if (max !== 'max' && maxBytes === null) return null;
  return { path, highEvents, stallMicros, highBytes, maxBytes, currentBytes };
}
