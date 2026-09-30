import type { Settings } from '@boite/contracts';
import type { ProcessLimits } from './platform/types.ts';

type MemoryLimits = Pick<ProcessLimits, 'budgetMb' | 'threadMemoryCapMb' | 'memoryReserveMb'>;

/** Resolve auto values once for the kernel limits and the pressure governor. */
export function resolveMemoryLimits(settings: Pick<Settings, 'agentMemoryBudgetPercent' | 'threadMemoryCapMb' | 'memoryReserveMb' | 'memoryProtection'>, totalBytes: number): MemoryLimits {
  if (settings.memoryProtection === false) return { budgetMb: 0, threadMemoryCapMb: 0, memoryReserveMb: 0 };
  const totalMb = totalBytes / (1024 * 1024);
  const roundDown = (mb: number): number => Math.floor(mb / 256) * 256;
  const budgetMb = roundDown(totalMb * settings.agentMemoryBudgetPercent / 100);
  return {
    budgetMb,
    threadMemoryCapMb: Math.min(settings.threadMemoryCapMb || roundDown(budgetMb / 2), budgetMb),
    memoryReserveMb: settings.memoryReserveMb || Math.max(totalMb * 0.1, 3072),
  };
}
