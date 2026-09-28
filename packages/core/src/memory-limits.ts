import type { Settings } from '@boite/contracts';
import type { ProcessLimits } from './platform/types.ts';

type MemoryLimits = Pick<ProcessLimits, 'agentMemoryBudgetMb' | 'threadMemoryCapMb' | 'memoryReserveMb'>;

/** Resolve auto values once for the kernel limits and the pressure governor. */
export function resolveMemoryLimits(settings: Pick<Settings, keyof MemoryLimits>, totalBytes: number): MemoryLimits {
  const totalMb = totalBytes / (1024 * 1024);
  const roundDown = (mb: number): number => Math.floor(mb / 256) * 256;
  const agentMemoryBudgetMb = settings.agentMemoryBudgetMb || roundDown(totalMb * 0.6);
  return {
    agentMemoryBudgetMb,
    threadMemoryCapMb: Math.min(settings.threadMemoryCapMb || roundDown(agentMemoryBudgetMb / 2), agentMemoryBudgetMb),
    memoryReserveMb: settings.memoryReserveMb || Math.max(totalMb * 0.1, 3072),
  };
}
