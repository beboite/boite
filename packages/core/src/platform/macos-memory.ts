import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { ProcessSample } from './types.ts';

function loadProc() {
  return dlopen('/usr/lib/libproc.dylib', {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
}

let native: ReturnType<typeof loadProc> | null = null;
let unavailable = false;

/**
 * rusage_info_v0: the 16-byte UUID precedes six counters, then resident size
 * at 64 and the physical footprint at 72. The footprint is what Activity
 * Monitor calls Memory: it leaves out the shared libraries resident size
 * counts once per process, which inflated a tree of compiler workers.
 */
export function residentMemory(buffer: Uint8Array): number {
  return Number(new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getBigUint64(72, true));
}

function readMemory(pid: number): number | null {
  if (unavailable) return null;
  try {
    native ??= loadProc();
    const buffer = new Uint8Array(96);
    if (native.symbols.proc_pid_rusage(pid, 0, ptr(buffer)) !== 0) return null;
    return residentMemory(buffer);
  } catch {
    unavailable = true;
    return null;
  }
}

interface MacIdentity { parentPid: number; birth: bigint }

/** proc_bsdinfo (136 bytes): parent pid at 16, start seconds/useconds at 120/128. */
export function macProcessIdentity(buffer: Uint8Array): MacIdentity {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { parentPid: view.getUint32(16, true), birth: view.getBigUint64(120, true) * 1_000_000n + view.getBigUint64(128, true) };
}

function readIdentity(pid: number): MacIdentity | null {
  if (unavailable) return null;
  try {
    native ??= loadProc();
    const buffer = new Uint8Array(136);
    // PROC_PIDTBSDINFO = 3. Short reads cannot establish a process identity.
    if (native.symbols.proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.byteLength) !== buffer.byteLength) return null;
    return macProcessIdentity(buffer);
  } catch {
    unavailable = true;
    return null;
  }
}

function listChildren(pid: number, buffer: Int32Array | null): number {
  if (unavailable) return -1;
  try {
    native ??= loadProc();
    return native.symbols.proc_listchildpids(pid, buffer === null ? null : ptr(buffer), buffer?.byteLength ?? 0);
  } catch {
    unavailable = true;
    return -1;
  }
}

/** libproc returns a PID count, not bytes. Retry a full buffer if children grew. */
export function macChildPids(pid: number, list: typeof listChildren = listChildren): number[] {
  let capacity = list(pid, null);
  if (capacity <= 0) return [];
  for (;;) {
    const buffer = new Int32Array(capacity + 1);
    const count = list(pid, buffer);
    if (count <= 0) return [];
    if (count < buffer.length) return [...buffer.subarray(0, count)].filter(child => child > 0);
    capacity = Math.max(count, buffer.length * 2);
  }
}

/** Memory includes registered roots and their descendants. CPU sampling stays unchanged. */
export class MacMemory {
  private readonly roots = new Map<string, Map<number, bigint | null>>();
  private readonly sampled = new Map<string, Map<number, bigint>>();

  constructor(
    private readonly read: (pid: number) => number | null = readMemory,
    private readonly children: (pid: number) => number[] = macChildPids,
    private readonly identify: (pid: number) => MacIdentity | null = readIdentity,
    private readonly signal: (pid: number) => void = pid => { process.kill(pid, 'SIGKILL'); },
  ) {}

  add(threadId: string, pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const roots = this.roots.get(threadId) ?? new Map<number, bigint | null>();
    roots.set(pid, this.identify(pid)?.birth ?? null);
    this.roots.set(threadId, roots);
  }

  remove(threadId: string, pid: number): void {
    const roots = this.roots.get(threadId);
    roots?.delete(pid);
    if (roots?.size === 0) { this.roots.delete(threadId); this.sampled.delete(threadId); }
  }

  /** A fresh walk authorizes only current descendants of unchanged registered roots. */
  private tree(threadId: string): Map<number, MacIdentity> {
    const roots = this.roots.get(threadId);
    const owners = new Map<number, string>();
    for (const [owner, registered] of this.roots) for (const pid of registered.keys()) owners.set(pid, owner);
    const pending = new Map<number, number | null>([...(roots?.keys() ?? [])].map(pid => [pid, null]));
    const tree = new Map<number, MacIdentity>();
    for (const [pid, parent] of pending) {
      if (owners.has(pid) && owners.get(pid) !== threadId) continue;
      const identity = this.identify(pid);
      if (identity === null || (roots?.has(pid) && roots.get(pid) !== identity.birth)
        || (parent !== null && identity.parentPid !== parent)) continue;
      if (parent !== null && this.identify(parent)?.birth !== tree.get(parent)?.birth) continue;
      const children = this.children(pid);
      if (this.identify(pid)?.birth !== identity.birth) continue;
      tree.set(pid, identity);
      for (const child of children) if (Number.isSafeInteger(child) && child > 0 && !pending.has(child)) pending.set(child, pid);
    }
    return tree;
  }

  /** Refuse stale samples, reused PIDs and processes outside this thread's current tree. */
  killTree(pid: number, threadId: string, startedAt?: number | null): boolean {
    const expected = this.roots.get(threadId)?.get(pid) ?? this.sampled.get(threadId)?.get(pid);
    if (expected == null || (startedAt !== undefined && (startedAt === null || Number(expected / 1000n) !== startedAt))) return false;
    const tree = this.tree(threadId);
    if (tree.get(pid)?.birth !== expected) return false;
    const victims = new Set([pid]);
    const children = new Map<number, number[]>();
    for (const [child, identity] of tree) {
      const siblings = children.get(identity.parentPid) ?? [];
      siblings.push(child);
      children.set(identity.parentPid, siblings);
    }
    for (const member of victims) for (const child of children.get(member) ?? []) victims.add(child);
    // Stop leaves first before they can be reparented.
    let stopped = false;
    for (const member of [...victims].reverse()) {
      if (this.identify(member)?.birth !== tree.get(member)?.birth) continue;
      try { this.signal(member); if (member === pid) stopped = true; } catch { /* Already gone or inaccessible. */ }
    }
    return stopped;
  }

  sample(threadId: string): ProcessSample | null {
    const births = new Map<number, bigint>();
    const workingSets = [...this.tree(threadId)].flatMap(([pid, identity]) => {
      const bytes = this.read(pid);
      if (bytes === null || this.identify(pid)?.birth !== identity.birth) return [];
      births.set(pid, identity.birth);
      return [{ pid, bytes }];
    });
    if (births.size > 0) this.sampled.set(threadId, births);
    else this.sampled.delete(threadId);
    if (!workingSets.length) return null;
    return { processes: workingSets.length, cpuPercent: 0, cpuMeasured: false, memoryMeasured: true,
      memoryBytes: workingSets.reduce((sum, process) => sum + process.bytes, 0), workingSets };
  }
}
