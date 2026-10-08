import type { MemoryEvent, MemoryState, MemoryStatus, Settings } from '@boite/contracts';
import { totalmem } from 'node:os';
import type { Bus } from './bus.ts';
import { decideMemory, initialMemoryPolicy, type MemoryProcess } from './memory-guard-logic.ts';
import { resolveMemoryLimits } from './memory-limits.ts';
import { calmThrottle, decideThrottle, type ThrottlePolicy } from './memory-throttle-logic.ts';
import type { CgroupMemory } from './platform/linux-cgroup.ts';
import type { ProcessPlatform } from './platform/types.ts';

/** Runs on the registry's load sample; owns no timer or native process handle. */
export class MemoryGuard {
  private policy = initialMemoryPolicy();
  private agentBytes = 0;
  private enabled = true;
  private limits: ReturnType<typeof resolveMemoryLimits> | null = null;
  private readonly throttles = new Map<string, ThrottlePolicy>();

  constructor(private readonly bus: Bus, private readonly platform: ProcessPlatform) {}

  get state(): MemoryState { return this.policy.state; }

  status(): MemoryStatus {
    if (this.limits === null) throw new Error('Memory limits have not been initialized');
    return { state: this.state, agentBytes: this.agentBytes, availableBytes: this.platform.machineMemory()?.availableBytes ?? null, limits: { ...this.limits } };
  }

  applySettings(settings: Settings): void {
    this.enabled = settings.memoryProtection !== false;
    this.limits = resolveMemoryLimits(settings, this.platform.machineMemory()?.totalBytes ?? totalmem());
    if (!this.enabled) {
      this.throttles.clear();
      const changed = this.state !== 'ok';
      this.policy = initialMemoryPolicy();
      if (changed) this.bus.emit('resources.memory', { threadId: null, kind: 'pressure', state: 'ok', at: Date.now() });
    }
  }

  sample(agentBytes: number, processes: MemoryProcess[], kill: (process: MemoryProcess) => boolean): void {
    if (this.limits === null) return;
    const at = Date.now();
    this.agentBytes = agentBytes;
    if (!this.enabled) return;
    const result = decideMemory(this.policy, {
      at, agentBytes, processes,
      availableBytes: this.platform.machineMemory()?.availableBytes ?? null,
      reserveBytes: this.limits.memoryReserveMb * 1024 * 1024,
      budgetBytes: this.limits.budgetMb * 1024 * 1024,
      quotaBytes: this.limits.threadMemoryCapMb * 1024 * 1024,
    });
    const changed = result.policy.state !== this.policy.state;
    this.policy = result.policy;
    if (changed) this.bus.emit('resources.memory', { threadId: null, kind: 'pressure', state: this.state, at });
    for (const threadId of result.nothingKillable) this.bus.emit('core.log', {
      level: 'warn', at, message: `Memory guard: thread ${threadId} has no killable process; root agent processes are protected.`,
    });
    for (const { process: victim, reason, limitBytes } of result.kills) {
      if (kill(victim)) this.bus.emit('resources.memory', {
        threadId: victim.threadId, kind: 'killed', pid: victim.pid, exe: victim.exe,
        bytes: victim.bytes, reason, limitBytes, state: this.state, at,
      });
    }
  }

  memoryLimit(threadId: string | null, kind: 'thread-cap' | 'budget'): void {
    if (!this.enabled) return;
    this.bus.emit('resources.memory', { threadId, kind, state: this.state, at: Date.now() });
  }

  /** The agent's own process names the cgroup its whole session was started in. */
  sampleThrottle(threadId: string, processes: Iterable<{ root: boolean; record: { pid: number } }>): void {
    if (!this.enabled || this.platform.cgroupMemory === undefined) return;
    let reading: CgroupMemory | null = null;
    // A root whose group cannot be read does not hide the next one's.
    for (const process of processes) {
      if (!process.root || !Number.isInteger(process.record.pid) || process.record.pid <= 0) continue;
      reading = this.platform.cgroupMemory(process.record.pid);
      if (reading !== null) break;
    }
    this.throttle(threadId, reading);
  }

  /** One reading of a thread's cgroup per load sample; a null reading only lets an old streak end. */
  throttle(threadId: string, reading: CgroupMemory | null, at = Date.now()): void {
    if (!this.enabled) return;
    if (reading === null) {
      const known = this.throttles.get(threadId);
      if (known !== undefined) this.throttles.set(threadId, calmThrottle(known, at));
      return;
    }
    const result = decideThrottle(this.throttles.get(threadId), reading, at);
    this.throttles.set(threadId, result.policy);
    if (result.notify) this.bus.emit('resources.memory', {
      threadId, kind: 'throttled', limitBytes: reading.highBytes, bytes: reading.currentBytes, state: this.state, at,
    });
  }

  forgetThrottle(threadId: string): void {
    this.throttles.delete(threadId);
  }
}

/** Stable prefix shared by live delivery and the next turn's system note. */
export function memoryNotice(event: MemoryEvent): string {
  const fact = event.kind === 'killed'
    ? `Stopped ${event.exe?.split(/[\\/]/).pop() ?? 'process'} (pid ${event.pid ?? 'unknown'}, ${Math.round((event.bytes ?? 0) / 1048576)} MB) because ${event.reason === 'thread-quota' ? `this conversation exceeded its memory quota (${Math.round(event.limitBytes / 1048576)} MB)` : event.reason === 'budget' ? `the agents exceeded their shared memory budget (${Math.round(event.limitBytes / 1048576)} MB)` : `available machine memory fell below the reserve (${Math.round(event.limitBytes / 1048576)} MB)`}.`
    : event.kind === 'thread-cap'
      ? 'An allocation was refused because this thread reached its memory cap.'
      : event.kind === 'budget'
        ? 'An allocation was refused because the agents reached their shared memory budget.'
        : event.kind === 'throttled'
          ? `This conversation's processes are being slowed by their memory limit (${Math.round(event.limitBytes / 1048576)} MB): they stall instead of failing.`
          : `Machine memory pressure is ${event.state}.`;
  // Nothing was stopped there, so there is nothing to rerun.
  if (event.kind === 'throttled') return `[Boite memory guard] ${fact} Nothing was stopped. Start no other heavy job beside it, and lower parallelism for the next one, for example \`cargo build -j 2\`.`;
  return `[Boite memory guard] ${fact} Do not rerun it unchanged; lower parallelism, for example \`cargo build -j 2\`; close editors or servers you started; run one heavy job at a time.`;
}
