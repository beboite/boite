import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { ProcessSample } from './types.ts';

function loadProc() {
  return dlopen('/usr/lib/libproc.dylib', {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
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

/** Direct children only, like the POSIX registry. CPU sampling stays unchanged. */
export class MacMemory {
  private readonly pids = new Map<string, Set<number>>();

  constructor(private readonly read: (pid: number) => number | null = readMemory) {}

  add(threadId: string, pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const pids = this.pids.get(threadId) ?? new Set<number>();
    pids.add(pid);
    this.pids.set(threadId, pids);
  }

  remove(threadId: string, pid: number): void {
    const pids = this.pids.get(threadId);
    pids?.delete(pid);
    if (pids?.size === 0) this.pids.delete(threadId);
  }

  sample(threadId: string): ProcessSample | null {
    const workingSets = [...(this.pids.get(threadId) ?? [])].flatMap(pid => {
      const bytes = this.read(pid);
      return bytes === null ? [] : [{ pid, bytes }];
    });
    if (!workingSets.length) return null;
    return { processes: workingSets.length, cpuPercent: 0, cpuMeasured: false, memoryMeasured: true,
      memoryBytes: workingSets.reduce((sum, process) => sum + process.bytes, 0), workingSets };
  }
}
