import type { MemoryState } from '@boite/contracts';

export interface MemoryProcess {
  threadId: string;
  pid: number;
  exe: string;
  bytes: number;
  root: boolean;
}

export interface MemorySample {
  availableBytes: number | null;
  reserveBytes: number;
  budgetBytes: number;
  agentBytes: number;
  kernelBudget: boolean;
  processes: MemoryProcess[];
  at: number;
}

export interface MemoryPolicy {
  state: MemoryState;
  recoverySamples: number;
  nextKillAt: number;
  reportedEmpty: boolean;
}

export function initialMemoryPolicy(): MemoryPolicy {
  return { state: 'ok', recoverySamples: 0, nextKillAt: 0, reportedEmpty: false };
}

/** Pure decisions: a failed read cannot release a hold, and recovery never kills. */
export function decideMemory(previous: MemoryPolicy, sample: MemorySample): {
  policy: MemoryPolicy; victim: MemoryProcess | null; nothingKillable: boolean;
} {
  const overBudget = !sample.kernelBudget && sample.agentBytes > sample.budgetBytes;
  const available = sample.availableBytes;
  const wanted: MemoryState = overBudget || (available !== null && available <= sample.reserveBytes)
    ? 'critical'
    : available === null ? previous.state : available <= sample.reserveBytes * 2 ? 'tight' : 'ok';
  const rank = { ok: 0, tight: 1, critical: 2 };
  const policy = { ...previous };
  if (rank[wanted] >= rank[previous.state]) {
    policy.state = wanted;
    policy.recoverySamples = 0;
  } else if (available !== null && ++policy.recoverySamples >= 2) {
    policy.state = wanted;
    policy.recoverySamples = 0;
  }
  if (policy.state !== 'critical') policy.reportedEmpty = false;
  let victim: MemoryProcess | null = null;
  let nothingKillable = false;
  if (wanted === 'critical' && (overBudget || (available !== null && available <= sample.reserveBytes))) {
    const candidates = sample.processes.filter(process => !process.root && process.pid > 0);
    if (candidates.length === 0) {
      nothingKillable = !policy.reportedEmpty;
      policy.reportedEmpty = true;
    } else if (sample.at >= policy.nextKillAt) {
      victim = candidates.reduce((largest, process) => process.bytes > largest.bytes ? process : largest);
      policy.nextKillAt = sample.at + 3000;
    }
  }
  return { policy, victim, nothingKillable };
}
