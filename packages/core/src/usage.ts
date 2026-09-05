import type { ThreadId, Usage } from '@boite/contracts';
import type { Core } from './core.ts';

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdEquivalent: null,
  };
}

function add(into: Usage, from: Usage): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  if (from.costUsdEquivalent !== null) into.costUsdEquivalent = (into.costUsdEquivalent ?? 0) + from.costUsdEquivalent;
}

export function usageOf(core: Core, threadId?: ThreadId): { byThread: Record<ThreadId, Usage>; total: Usage } {
  const byThread: Record<ThreadId, Usage> = {};
  const total = emptyUsage();
  for (const turn of core.journal.listTurns(threadId)) {
    if (turn.usage === null) continue;
    const bucket = byThread[turn.threadId] ?? emptyUsage();
    add(bucket, turn.usage);
    byThread[turn.threadId] = bucket;
    add(total, turn.usage);
  }
  return { byThread, total };
}

export function registerUsageMethods(core: Core): void {
  core.router.register('usage.get', (params) => usageOf(core, params.threadId));
}
