import type { MemoryKillReason, MemoryState } from '@boite/contracts';

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
  quotaBytes: number;
  agentBytes: number;
  processes: MemoryProcess[];
  at: number;
}

export interface MemoryPolicy {
  state: MemoryState;
  recoverySamples: number;
  nextKillAt: Map<string, number>;
  reportedEmpty: Set<string>;
}

export function initialMemoryPolicy(): MemoryPolicy {
  return { state: 'ok', recoverySamples: 0, nextKillAt: new Map(), reportedEmpty: new Set() };
}

/** The most a machine-reserve floor asks of a thread, whatever the reserve. */
const MACHINE_KILL_FLOOR_BYTES = 256 * 1024 * 1024;

/**
 * What a thread must hold before the machine reserve stops one of its
 * processes: an eighth of the reserve, at most 256 MiB. Below it the shortage
 * comes from other programs and the kill frees too little to restore anything.
 */
export function machineKillFloor(reserveBytes: number): number {
  return Math.min(MACHINE_KILL_FLOOR_BYTES, reserveBytes / 8);
}

/** Pure decisions. Each offending thread gets at most one victim per sample. */
export function decideMemory(previous: MemoryPolicy, sample: MemorySample): {
  policy: MemoryPolicy;
  kills: { process: MemoryProcess; reason: MemoryKillReason; limitBytes: number }[];
  nothingKillable: string[];
} {
  const totals = new Map<string, number>();
  for (const process of sample.processes) totals.set(process.threadId, (totals.get(process.threadId) ?? 0) + process.bytes);
  const targets = new Map<string, { reason: MemoryKillReason; limitBytes: number }>();
  for (const [threadId, bytes] of totals) {
    if (bytes > sample.quotaBytes) targets.set(threadId, { reason: 'thread-quota', limitBytes: sample.quotaBytes });
  }
  const overBudget = sample.agentBytes > sample.budgetBytes;
  const underReserve = sample.availableBytes !== null && sample.availableBytes < sample.reserveBytes;
  const machineFloor = machineKillFloor(sample.reserveBytes);
  if (overBudget || underReserve) {
    const [heaviest, heaviestBytes = 0] = [...totals].sort((a, b) => b[1] - a[1])[0] ?? [];
    // Under the reserve alone, other programs may hold the memory: a thread
    // lighter than the floor is not the cause and stopping it frees nothing.
    const counts = overBudget || heaviestBytes >= machineFloor;
    if (heaviest !== undefined && counts && !targets.has(heaviest)) targets.set(heaviest, {
      reason: overBudget ? 'budget' : 'machine',
      limitBytes: overBudget ? sample.budgetBytes : sample.reserveBytes,
    });
  }
  const policy: MemoryPolicy = {
    ...previous, nextKillAt: new Map(previous.nextKillAt), reportedEmpty: new Set(previous.reportedEmpty),
  };
  if (targets.size || overBudget || underReserve) {
    policy.state = 'critical';
    policy.recoverySamples = 0;
  } else if (sample.availableBytes === null) {
    policy.recoverySamples = 0;
  } else if (++policy.recoverySamples >= 2) {
    policy.state = 'ok';
    policy.recoverySamples = 0;
  }
  for (const threadId of policy.reportedEmpty) if (!targets.has(threadId)) policy.reportedEmpty.delete(threadId);
  for (const [threadId, until] of policy.nextKillAt) if (sample.at >= until) policy.nextKillAt.delete(threadId);
  const kills: ReturnType<typeof decideMemory>['kills'] = [];
  const nothingKillable: string[] = [];
  for (const [threadId, limit] of targets) {
    const killable = sample.processes.filter(process => process.threadId === threadId && !process.root && process.pid > 0)
      .sort((a, b) => b.bytes - a.bytes);
    // A helper of a few MB beside a heavy protected root (an agent's sign-in
    // process) is not what fills the machine: stopping it only breaks the agent.
    const worthStopping = limit.reason !== 'machine' || killable.reduce((sum, process) => sum + process.bytes, 0) >= machineFloor;
    const victim = worthStopping ? killable[0] : undefined;
    if (victim === undefined) {
      if (!policy.reportedEmpty.has(threadId)) nothingKillable.push(threadId);
      policy.reportedEmpty.add(threadId);
    } else if (!policy.nextKillAt.has(threadId)) {
      policy.reportedEmpty.delete(threadId);
      kills.push({ process: victim, ...limit });
      policy.nextKillAt.set(threadId, sample.at + 3000);
    }
  }
  return { policy, kills, nothingKillable };
}
