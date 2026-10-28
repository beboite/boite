import type { ProviderId, ThreadId, Usage, UsageHistory, UsageHistoryRow, UsageHistoryThread, UsagePrice } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';
import type { UsageSums } from './journal/usage-sums.ts';
import { priceUsage } from './pricing/index.ts';

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
  const hour = (into.cacheWriteHourTokens ?? 0) + (from.cacheWriteHourTokens ?? 0);
  if (hour > 0) into.cacheWriteHourTokens = hour;
  if (from.costUsdEquivalent !== null) into.costUsdEquivalent = (into.costUsdEquivalent ?? 0) + from.costUsdEquivalent;
}

/** Two reports of one turn as one; a cost neither carried stays unknown. */
export function sumUsage(left: Usage, right: Usage): Usage {
  const sum: Usage = { ...left, costUsdEquivalent: left.costUsdEquivalent };
  add(sum, right);
  return sum;
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

function sumsToUsage(sums: UsageSums): Usage {
  return {
    inputTokens: sums.input_tokens,
    outputTokens: sums.output_tokens,
    cacheReadTokens: sums.cache_read_tokens,
    cacheWriteTokens: sums.cache_write_tokens,
    ...(sums.cache_write_hour_tokens > 0 ? { cacheWriteHourTokens: sums.cache_write_hour_tokens } : {}),
    costUsdEquivalent: sums.cost,
  };
}

interface Priced {
  usage: Usage;
  priced: number;
  price: UsagePrice | null;
}

/**
 * The API-equivalent cost of a group of turns: their tokens at the model's
 * public rates when the price list knows the model, else the costs the agents
 * reported. Rates come first because a reported cost is only as good as the
 * agent's own sum: Claude's is a running total the driver has to take apart,
 * Codex and Grok report none, and a rate prices every provider the same way.
 * Only what each turn stored decides it, never the provider's descriptor, so
 * editing or removing a provider leaves the turns recorded since as they were.
 */
function priced(sums: UsageSums, model: string | null): Priced {
  const usage = sumsToUsage(sums);
  const quote = priceUsage(model, usage);
  if (quote === null || sums.reported === 0) return { usage, priced: sums.priced, price: quote?.price ?? null };
  return { usage: { ...usage, costUsdEquivalent: quote.cost }, priced: sums.reported, price: quote.price };
}

/**
 * Turns an older core recorded, read as their provider counted: Codex's input
 * held both caches and Claude Code wrote for an hour. Nothing in such a turn
 * says which protocol produced it, so this asks the provider's descriptor as
 * it is now, without rewriting the turn, and the row counts them as estimated.
 */
function estimate(sums: UsageSums, protocol: string | null): UsageSums {
  if (protocol === 'codex-appserver') return { ...sums, input_tokens: Math.max(0, sums.input_tokens - sums.cache_read_tokens - sums.cache_write_tokens) };
  if (protocol === 'claude-sdk') return { ...sums, cache_write_hour_tokens: sums.cache_write_tokens };
  return sums;
}

export function usageHistory(core: Core, edges: number[], providerId?: ProviderId): UsageHistory {
  // A provider removed since keeps its protocol through its shipped id.
  const protocolOf = (id: ProviderId): string | null => core.providers.get(id)?.protocol ?? (id === 'claude' ? 'claude-sdk' : id === 'codex' ? 'codex-appserver' : null);
  const read = (row: UsageSums & { provider_id: ProviderId; model: string | null }): Priced =>
    priced(row.legacy ? estimate(row, protocolOf(row.provider_id)) : row, row.model);

  // The turns an older core recorded come as their own group; a row joins both.
  const rows = new Map<string, UsageHistoryRow>();
  for (const row of core.journal.usageByBucket(edges)) {
    if (providerId !== undefined && row.provider_id !== providerId) continue;
    const cost = read(row);
    const estimated = row.legacy ? row.reported : 0;
    const key = JSON.stringify([row.bucket, row.provider_id, row.model]);
    const entry = rows.get(key);
    if (entry === undefined) {
      rows.set(key, {
        bucket: row.bucket,
        providerId: row.provider_id,
        model: row.model,
        turns: row.turns,
        reported: row.reported,
        priced: cost.priced,
        ...(estimated > 0 ? { estimated } : {}),
        usage: cost.usage,
        price: cost.price,
      });
      continue;
    }
    entry.turns += row.turns;
    entry.reported += row.reported;
    entry.priced += cost.priced;
    if (estimated > 0) entry.estimated = (entry.estimated ?? 0) + estimated;
    add(entry.usage, cost.usage);
    entry.price ??= cost.price;
  }

  const byThread = new Map<ThreadId, UsageHistoryThread>();
  for (const row of core.journal.usageByThread(edges[0]!, edges[edges.length - 1]!)) {
    if (providerId !== undefined && row.provider_id !== providerId) continue;
    const { usage } = read(row);
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
      providerId: providerId ?? row.thread_provider_id,
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
  return { edges, rows: [...rows.values()], threads: [...kept] };
}

export function registerUsageMethods(core: Core): void {
  core.router.register('usage.get', (params) => usageOf(core, params.threadId));
  core.router.register('usage.history', (params) => {
    const edges = checkEdges(params?.edges);
    if (params.providerId !== undefined && (typeof params.providerId !== 'string' || !params.providerId.trim())) {
      throw invalidParams('providerId: expected a non-empty provider id', { field: 'providerId' });
    }
    return usageHistory(core, edges, params.providerId);
  });
}
