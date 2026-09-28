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
  if (overBudget || underReserve) {
    const heaviest = [...totals].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (heaviest !== undefined && !targets.has(heaviest)) targets.set(heaviest, {
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
    const victim = sample.processes.filter(process => process.threadId === threadId && !process.root && process.pid > 0)
      .sort((a, b) => b.bytes - a.bytes)[0];
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
