import type { ProviderId, ThreadId, Usage, UsageHistory, UsageHistoryThread } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';
import type { UsageSums } from './journal/usage-sums.ts';

/** A year of days plus the closing edge. */
export const MAX_USAGE_EDGES = 367;

/** How many threads each ranking of `usage.history` keeps. */
export const TOP_THREADS = 10;

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

/** Every token the provider processed for these turns, cache included. */
export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
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

function checkEdges(edges: unknown): number[] {
  const valid =
    Array.isArray(edges) &&
    edges.length >= 2 &&
    edges.length <= MAX_USAGE_EDGES &&
    edges.every((edge, index) => typeof edge === 'number' && Number.isFinite(edge) && (index === 0 || edge > edges[index - 1]));
  if (!valid) {
    throw invalidParams(`edges: expected 2 to ${MAX_USAGE_EDGES} strictly ascending timestamps in milliseconds`, { field: 'edges' });
  }
  return edges as number[];
}

/**
 * Codex reports the cached input inside `inputTokens`; Claude, ACP and pi
 * count it apart. The history takes the cache reads out of Codex's input so
 * the four token fields add up the same way for every provider.
 */
function sumsToUsage(sums: UsageSums, cachedInInput: boolean): Usage {
  return {
    inputTokens: cachedInInput ? Math.max(0, sums.input_tokens - sums.cache_read_tokens) : sums.input_tokens,
    outputTokens: sums.output_tokens,
    cacheReadTokens: sums.cache_read_tokens,
    cacheWriteTokens: sums.cache_write_tokens,
    costUsdEquivalent: sums.cost,
  };
}

export function usageHistory(core: Core, edges: number[]): UsageHistory {
  const cachedInInput = (providerId: ProviderId): boolean => core.providers.get(providerId)?.protocol === 'codex-appserver';
  const rows = core.journal.usageByBucket(edges).map((row) => ({
    bucket: row.bucket,
    providerId: row.provider_id,
    model: row.model,
    turns: row.turns,
    reported: row.reported,
    priced: row.priced,
    usage: sumsToUsage(row, cachedInInput(row.provider_id)),
  }));

  const byThread = new Map<ThreadId, UsageHistoryThread>();
  for (const row of core.journal.usageByThread(edges[0]!, edges[edges.length - 1]!)) {
    const usage = sumsToUsage(row, cachedInInput(row.provider_id));
    const entry = byThread.get(row.thread_id);
    if (entry !== undefined) {
      entry.turns += row.turns;
      add(entry.usage, usage);
      continue;
    }
    byThread.set(row.thread_id, {
      threadId: row.thread_id,
      title: row.title,
      projectId: row.project_id,
      providerId: row.thread_provider_id,
      archived: row.archived !== 0,
      turns: row.turns,
      usage,
    });
  }

  const all = [...byThread.values()];
  const rankings: ((thread: UsageHistoryThread) => number)[] = [
    (thread) => totalTokens(thread.usage),
    (thread) => thread.usage.costUsdEquivalent ?? 0,
    (thread) => thread.turns,
  ];
  const kept = new Set<UsageHistoryThread>();
  for (const measure of rankings) {
    const ranked = all.filter((thread) => measure(thread) > 0).sort((a, b) => measure(b) - measure(a));
    for (const thread of ranked.slice(0, TOP_THREADS)) kept.add(thread);
  }
  return { edges, rows, threads: [...kept] };
}

export function registerUsageMethods(core: Core): void {
  core.router.register('usage.get', (params) => usageOf(core, params.threadId));
  core.router.register('usage.history', (params) => usageHistory(core, checkEdges(params?.edges)));
}
