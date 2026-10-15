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
import { LinuxResources, type LinuxResourceProcess } from './linux-resources.ts';

/**
 * The unit of the stat file's CPU fields. The kernel fixes the value it exports
 * to user space at 100 on every architecture Boite runs on, whatever its own tick.
 */
export const USER_HZ = 100;

/** File text or newline-separated directory entries; null when gone or unreadable. */
export type ProcRead = (path: string) => string | null;

function readProc(path: string): string | null {
  try {
    if (path === '/proc' || path.endsWith('/task') || path.endsWith('/fd')) return readdirSync(path).join('\n');
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

/** The command name, field 2 of a stat line: from the first `(` to the last `)`. */
function statComm(stat: string): string {
  return stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
}

/**
 * The boot time, per reader: fixed until reboot, and `/proc/stat` is several
 * KB on a machine with many cores, read at every spawn otherwise.
 */
const boots = new WeakMap<ProcRead, number>();

function bootSeconds(read: ProcRead): number | null {
  const known = boots.get(read);
  if (known !== undefined) return known;
  const boot = /^btime\s+(\d+)$/m.exec(read('/proc/stat') ?? '');
  if (boot === null) return null;
  boots.set(read, Number(boot[1]));
  return Number(boot[1]);
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
  if (ticks === null) return null;
  const boot = bootSeconds(read);
  if (boot === null) return null;
  return boot * 1000 + Math.round((ticks * 1000) / USER_HZ);
}

/**
 * The memory a process holds for itself, in bytes: its anonymous and shared
 * memory pages, RssAnon plus RssShmem. VmRSS also counts the file pages every
 * process maps, so sixteen rustc workers each counted the same compiler
 * library and a build crossed the memory guard's cap with a fraction of it in
 * use. VmRSS remains the fallback for kernels older than 4.5. Null when the
 * lines are missing (a zombie has none).
 */
export function residentBytes(status: string): number | null {
  const kb = (field: string) => {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(status);
    return match === null ? null : Number(match[1]) * 1024;
  };
  const anonymous = kb('RssAnon');
  if (anonymous !== null) return anonymous + (kb('RssShmem') ?? 0);
  return kb('VmRSS');
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
  /** Rebuilt in registry insertion order, so duplicate roots retain the same winner. */
  #owners: Map<number, string> | null = null;
  readonly #births = new Map<string, Map<number, number | null>>();
  /** The thread's CPU ticks at its previous sample, per pid, and when that was. */
  readonly #last = new Map<string, { ticks: Map<number, number>; births: Map<number, number | null>; at: number }>();
  /** One parent scan serves every thread sampled in the same tick. */
  #scan: ProcSnapshot | null = null;
  /**
   * Each sampled process's name, per thread, while it stays in the sample.
   * `/proc/<pid>/comm` is read again only for a new birth or when the stat
   * line's own name changes, as an `exec` does.
   */
  readonly #names = new Map<string, Map<number, { birth: number | null; comm: string; exe: string | undefined }>>();
  readonly #resources: LinuxResources;

  constructor(
    private readonly logicalCpus: number,
    private readonly read: ProcRead = readProc,
    private readonly now: () => number = Date.now,
    private readonly signal: (pid: number) => void = (pid) => { process.kill(pid, 'SIGKILL'); },
  ) { this.#resources = new LinuxResources(read, now); }

  watchResources(active: boolean): void { this.#resources.watch(active); }

  finishResources(): void { this.#resources.finish(); }

  closeResources(): Promise<void> { return this.#resources.close(); }

  forget(threadId: string): void { this.#resources.forget(threadId); this.#names.delete(threadId); }

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
   * holding their memory. Only a registered or sampled birth can authorize a
   * signal: a pid may have been given to an unrelated process in the meantime.
   * False when the process itself could not be identified or signalled.
   */
  killTree(pid: number, threadId: string, startedAt?: number | null): boolean {
    const registered = this.#births.get(threadId);
    const birth = registered?.has(pid) ? registered.get(pid) : this.#last.get(threadId)?.births.get(pid);
    if (birth == null || !Number.isSafeInteger(birth)) return false;
    if (startedAt !== undefined && (startedAt === null || linuxStartedAt(pid, this.read) !== startedAt)) return false;
    const scan = this.#snapshot(true);
    const root = scan.stats.get(pid) ?? this.read(`/proc/${pid}/stat`);
    if (root === null || statField(root, 22) !== birth) return false;
    const tree = new Map([[pid, birth]]);
    for (const [member] of tree) {
      for (const child of this.#children(member, scan, true)) {
        const stat = scan.stats.get(child) ?? this.read(`/proc/${child}/stat`);
        const childBirth = stat === null ? null : statField(stat, 22);
        if (stat === null || childBirth === null || !Number.isSafeInteger(childBirth) || statField(stat, 4) !== member) continue;
        if (!tree.has(child)) tree.set(child, childBirth);
      }
    }
    let stopped = false;
    for (const [member, expectedBirth] of tree) {
      const stat = this.read(`/proc/${member}/stat`);
      if (stat === null || statField(stat, 22) !== expectedBirth) continue;
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
    this.#owners = null;
    let births = this.#births.get(threadId);
    if (births === undefined) { births = new Map(); this.#births.set(threadId, births); }
    const stat = this.read(`/proc/${pid}/stat`);
    births.set(pid, stat === null ? null : statField(stat, 22));
  }

  remove(threadId: string, pid: number): void {
    const pids = this.#pids.get(threadId);
    if (pids === undefined) return;
    pids.delete(pid);
    this.#owners = null;
    this.#births.get(threadId)?.delete(pid);
    if (pids.size > 0) return;
    this.#pids.delete(threadId);
    this.#births.delete(threadId);
    this.#last.delete(threadId);
    this.#names.delete(threadId);
    this.#resources.forget(threadId);
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
    const sampledBirths = new Map<number, number | null>();
    let memoryBytes = 0;
    const workingSets: NonNullable<ProcessSample['workingSets']> = [];
    let processes = 0;
    const scan = this.#snapshot();
    const at = this.now();
    const pending = new Set(pids);
    let owners = this.#owners;
    if (owners === null) {
      owners = new Map<number, string>();
      for (const [owner, roots] of this.#pids) for (const root of roots) owners.set(root, owner);
      this.#owners = owners;
    }
    const members: LinuxResourceProcess[] = [];
    const names = this.#names.get(threadId);
    const sampledNames = new Map<number, { birth: number | null; comm: string; exe: string | undefined }>();
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
      const birth = stat === null ? null : statField(stat, 22);
      const expectedBirth = this.#births.get(threadId)?.get(pid);
      if (pids.has(pid) && expectedBirth != null && birth !== expectedBirth) continue;
      if (birth !== null && Number.isSafeInteger(birth) && (!pids.has(pid) || expectedBirth === birth)) members.push({ pid, birth });
      processes += 1;
      ticks.set(pid, used);
      sampledBirths.set(pid, birth);
      const bytes = status === null ? null : residentBytes(status);
      const comm = stat === null ? '' : statComm(stat);
      const named = names?.get(pid);
      const exe = named !== undefined && named.birth === birth && named.comm === comm ? named.exe : this.read(`/proc/${pid}/comm`)?.trim();
      sampledNames.set(pid, { birth, comm, exe });
      if (bytes !== null) workingSets.push({ pid, bytes, ...(exe ? { exe } : {}) });
      memoryBytes += bytes ?? 0;
      // A separately registered agent owns its own subtree, even when nested.
      for (const child of this.#children(pid, scan)) if (!owners.has(child) || owners.get(child) === threadId) pending.add(child);
    }
    if (processes === 0) { this.#resources.forget(threadId); this.#names.delete(threadId); return null; }
    this.#names.set(threadId, sampledNames);

    const previous = this.#last.get(threadId);
    this.#last.set(threadId, { ticks, births: sampledBirths, at });
    let cpuPercent = 0;
    let cpuMeasured = false;
    const elapsedMs = previous === undefined ? 0 : at - previous.at;
    if (previous !== undefined && elapsedMs > 0) {
      // Per pid, so a process that exited or started in between moves nothing.
      let spent = 0;
      for (const [pid, now] of ticks) {
        const before = previous.ticks.get(pid);
        if (before !== undefined && sampledBirths.get(pid) === previous.births.get(pid) && now >= before) {
          spent += now - before; cpuMeasured = sampledBirths.get(pid) !== null || cpuMeasured;
        }
      }
      const cpuMs = (spent * 1000) / USER_HZ;
      cpuPercent = Math.round((cpuMs / (elapsedMs * Math.max(1, this.logicalCpus))) * 1000) / 10;
    }
    const resources = this.#resources.sample(threadId, members);
    const trustedRoots = [...pids].every(pid => this.#births.get(threadId)?.get(pid) != null);
    return { processes, cpuPercent, memoryBytes, workingSets,
      cpuMeasured: cpuMeasured && trustedRoots,
      memoryMeasured: workingSets.length > 0 && trustedRoots, ...(resources ? { resources } : {}) };
  }
}
