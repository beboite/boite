import { cpus, totalmem } from 'node:os';
import type { MachineResourceSnapshot, Os, ThreadId } from '@boite/contracts';
import { machineName } from './paths.ts';
import type { ProcessPlatform } from './platform/types.ts';
import type { ProcRegistry } from './procs.ts';

/** Readings this fresh are handed to every caller instead of being read again: two windows poll at once. */
const SHARE_MS = 1_000;
/** A first CPU reading has no interval; this one is short enough for a page that has just opened. */
const FIRST_CPU_INTERVAL_MS = 200;

interface CpuTimes { idle: number; total: number }

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

export function cpuPercent(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, (1 - (after.idle - before.idle) / total) * 100));
}

export interface MachineAgents {
  /** The live pids of each agent, for a per-agent GPU share. */
  pids: Map<ThreadId, number[]>;
  /** Measured agent memory, summed. */
  memoryBytes: number;
}

/**
 * The whole machine for the task manager: CPU across every core, memory, every
 * GPU and the fixed volumes. Nothing is sampled until a client asks, and a GPU
 * reader the platform opens closes itself once the asking stops.
 */
export class MachineResources {
  private lastCpu: CpuTimes | null = null;
  private shared: { at: number; reading: Promise<MachineResourceSnapshot>; settled: boolean } | null = null;

  constructor(
    private readonly platform: ProcessPlatform,
    private readonly os: Os,
    private readonly agents: () => MachineAgents,
    private readonly now: () => number = Date.now,
  ) {}

  read(): Promise<MachineResourceSnapshot> {
    const at = this.now();
    // A slow sample (nvidia-smi may take two seconds) is waited for, not overlapped: two would race on `lastCpu`.
    if (this.shared !== null && (!this.shared.settled || at - this.shared.at < SHARE_MS)) return this.shared.reading;
    const shared = { at, reading: this.sample(), settled: false };
    this.shared = shared;
    shared.reading.then(() => { shared.settled = true; }, () => { if (this.shared === shared) this.shared = null; });
    return shared.reading;
  }

  private async sample(): Promise<MachineResourceSnapshot> {
    const agents = this.agents();
    const owners = new Map<number, ThreadId>();
    for (const [threadId, pids] of agents.pids) for (const pid of pids) owners.set(pid, threadId);
    const gpuReading = this.platform.machineGpus?.(new Set(owners.keys())) ?? Promise.resolve(null);
    if (this.lastCpu === null) {
      this.lastCpu = cpuTimes();
      await Bun.sleep(FIRST_CPU_INTERVAL_MS);
    }
    const before = this.lastCpu;
    const after = cpuTimes();
    this.lastCpu = after;
    const gpu = await gpuReading.catch(() => null);
    let agentGpu: MachineResourceSnapshot['agentGpu'] = null;
    if (gpu?.pids) {
      const byThread = new Map<ThreadId, number>([...agents.pids.keys()].map(threadId => [threadId, 0]));
      for (const [pid, percent] of gpu.pids) {
        const threadId = owners.get(pid);
        if (threadId !== undefined) byThread.set(threadId, Math.min(100, Math.max(byThread.get(threadId) ?? 0, percent)));
      }
      agentGpu = [...byThread].map(([threadId, percent]) => ({ threadId, percent }));
    }
    const list = cpus();
    const memory = this.platform.machineMemory();
    return {
      sampledAt: this.now(),
      hostname: machineName(),
      os: this.os,
      osLabel: this.platform.osLabel?.() ?? null,
      cpu: { model: list[0]?.model.trim() || null, cores: list.length, percent: cpuPercent(before, after) },
      memory: { totalBytes: memory?.totalBytes ?? totalmem(), availableBytes: memory?.availableBytes ?? null, agentBytes: agents.memoryBytes },
      gpus: gpu?.gpus ?? null,
      agentGpu,
      volumes: this.platform.machineVolumes?.() ?? [],
    };
  }
}

const sampled = new WeakMap<ProcRegistry, MachineResources>();

/** A core's machine, sampled on the first `resources.machine`: nothing is read before a task manager opens. */
export function machineResources(procs: ProcRegistry): Promise<MachineResourceSnapshot> {
  let machine = sampled.get(procs);
  if (machine === undefined) {
    machine = new MachineResources(procs.platform, procs.capability().os, () => {
      const pids = new Map<ThreadId, number[]>();
      let memoryBytes = 0;
      for (const threadId of procs.liveThreads()) {
        pids.set(threadId, procs.liveOf(threadId).map(record => record.pid));
        memoryBytes += procs.loadOf(threadId)?.memoryBytes ?? 0;
      }
      return { pids, memoryBytes };
    });
    sampled.set(procs, machine);
  }
  return machine.read();
}
