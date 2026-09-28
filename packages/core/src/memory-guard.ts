import type { MemoryEvent, MemoryState, MemoryStatus, Settings } from '@boite/contracts';
import { totalmem } from 'node:os';
import type { Bus } from './bus.ts';
import { decideMemory, initialMemoryPolicy, type MemoryProcess } from './memory-guard-logic.ts';
import { resolveMemoryLimits } from './memory-limits.ts';
import type { ProcessPlatform } from './platform/types.ts';

/** Runs on the registry's load sample; owns no timer or native process handle. */
export class MemoryGuard {
  private policy = initialMemoryPolicy();
  private limits: ReturnType<typeof resolveMemoryLimits> | null = null;

  constructor(private readonly bus: Bus, private readonly platform: ProcessPlatform) {}

  get state(): MemoryState { return this.policy.state; }

  status(agentBytes: number): MemoryStatus {
    if (this.limits === null) throw new Error('Memory limits have not been initialized');
    return { state: this.state, agentBytes, availableBytes: this.platform.machineMemory()?.availableBytes ?? null, limits: { ...this.limits } };
  }

  applySettings(settings: Settings): void {
    this.limits = resolveMemoryLimits(settings, this.platform.machineMemory()?.totalBytes ?? totalmem());
  }

  sample(agentBytes: number, processes: MemoryProcess[], kill: (process: MemoryProcess) => boolean): void {
    if (this.limits === null) return;
    const at = Date.now();
    const result = decideMemory(this.policy, {
      at, agentBytes, processes,
      availableBytes: this.platform.machineMemory()?.availableBytes ?? null,
      reserveBytes: this.limits.memoryReserveMb * 1024 * 1024,
      budgetBytes: this.limits.agentMemoryBudgetMb * 1024 * 1024,
      kernelBudget: this.platform.kernelMemoryBudget?.() ?? false,
    });
    const changed = result.policy.state !== this.policy.state;
    this.policy = result.policy;
    if (changed) this.bus.emit('resources.memory', { threadId: null, kind: 'pressure', state: this.state, at });
    if (result.nothingKillable) this.bus.emit('core.log', {
      level: 'warn', at, message: 'Memory guard: no killable process remains; root agent processes are protected.',
    });
    const victim = result.victim;
    if (victim !== null && kill(victim)) this.bus.emit('resources.memory', {
      threadId: victim.threadId, kind: 'killed', pid: victim.pid, exe: victim.exe,
      bytes: victim.bytes, state: this.state, at,
    });
  }

  memoryLimit(threadId: string | null, kind: 'thread-cap' | 'budget'): void {
    this.bus.emit('resources.memory', { threadId, kind, state: this.state, at: Date.now() });
  }
}

/** Stable prefix shared by live delivery and the next turn's system note. */
export function memoryNotice(event: MemoryEvent): string {
  const fact = event.kind === 'killed'
    ? `Stopped ${event.exe ?? 'process'} (pid ${event.pid ?? 'unknown'}, ${Math.round((event.bytes ?? 0) / 1048576)} MB in memory) because machine memory is critical or the agent memory budget was exceeded.`
    : event.kind === 'thread-cap'
      ? 'An allocation was refused because this thread reached its memory cap.'
      : event.kind === 'budget'
        ? 'An allocation was refused because the agents reached their shared memory budget.'
        : `Machine memory pressure is ${event.state}.`;
  return `[Boite memory guard] ${fact} Do not rerun it unchanged; lower parallelism, for example \`cargo build -j 2\`; close editors or servers you started; run one heavy job at a time.`;
}
