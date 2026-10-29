import type { ProviderId, ThreadId, Usage, UsageHistory, UsageHistoryRow, UsageHistoryThread, UsagePrice } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';
import { usageGroups, type UsageGroup, type UsageSums } from './journal/usage-sums.ts';
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

/** A provider removed since keeps its protocol through its shipped id. */
function protocolOf(core: Core, id: ProviderId): string | null {
  return core.providers.get(id)?.protocol ?? (id === 'claude' ? 'claude-sdk' : id === 'codex' ? 'codex-appserver' : null);
}

/**
 * Turns an older core recorded, read as their provider counted: Codex's input
 * held both caches and Claude Code wrote for an hour. Nothing in such a turn
 * says which protocol produced it, so this asks the provider's descriptor as
 * it is now, without rewriting the turn.
 */
function estimate(usage: Usage, protocol: string | null): Usage {
  if (protocol === 'codex-appserver') return { ...usage, inputTokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens) };
  if (protocol === 'claude-sdk' && usage.cacheWriteTokens > 0) return { ...usage, cacheWriteHourTokens: usage.cacheWriteTokens };
  return usage;
}

/**
 * A group of turns as disjoint buckets: the one reading every total of the
 * core uses, so `usage.get`, `usage.history`, a session, a workflow and a
 * delegation team count an older turn the same way.
 */
function groupUsage(core: Core, group: UsageSums & { provider_id: ProviderId }): Usage {
  const usage = sumsToUsage(group);
  return group.legacy ? estimate(usage, protocolOf(core, group.provider_id)) : usage;
}

/** `usageGroups` summed per key. */
export function sumGroups(core: Core, groups: readonly UsageGroup[]): Map<string | null, Usage> {
  const sums = new Map<string | null, Usage>();
  for (const group of groups) {
    const usage = groupUsage(core, group);
    const into = sums.get(group.key);
    if (into === undefined) sums.set(group.key, usage);
    else add(into, usage);
  }
  return sums;
}

/** `usageGroups` summed whole. */
export function usageTotal(core: Core, groups: readonly UsageGroup[]): Usage {
  const total = emptyUsage();
  for (const group of groups) add(total, groupUsage(core, group));
  return total;
}

/** What an agent session already used: its last reported totals, else its turns (`Journal.sessionUsage`). */
export function sessionUsage(core: Core, threadId: ThreadId, generation: number, exceptTurnId: string): { costUsd: number; tokens: number } {
  const { reported, groups } = core.journal.sessionUsage(threadId, generation, exceptTurnId);
  if (reported !== null) return reported;
  const usage = usageTotal(core, groups);
  return { costUsd: usage.costUsdEquivalent ?? 0, tokens: totalTokens(usage) };
}

export function usageOf(core: Core, threadId?: ThreadId): { byThread: Record<ThreadId, Usage>; total: Usage } {
  const groups = threadId === undefined
    ? usageGroups(core.journal.db, { key: 't.thread_id', where: '1' })
    : usageGroups(core.journal.db, { key: 't.thread_id', where: 't.thread_id = ?' }, threadId);
  return { byThread: Object.fromEntries(sumGroups(core, groups)) as Record<ThreadId, Usage>, total: usageTotal(core, groups) };
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

export interface Priced {
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
function priced(usage: Usage, sums: UsageSums, model: string | null): Priced {
  const quote = priceUsage(model, usage);
  if (quote === null || sums.reported === 0) return { usage, priced: sums.priced, price: quote?.price ?? null };
  return { usage: { ...usage, costUsdEquivalent: quote.cost }, priced: sums.reported, price: quote.price };
}

/**
 * The turns of one provider and model priced the way `usage.history` prices
 * them (`priced`); a bot's daily budget reads the same rule (`agents/spend.ts`).
 */
export function priceGroup(core: Core, row: UsageSums & { provider_id: ProviderId; model: string | null }): Priced {
  return priced(groupUsage(core, row), row, row.model);
}

export function usageHistory(core: Core, edges: number[], providerId?: ProviderId): UsageHistory {
  // The turns an older core recorded come as their own group, which the row counts as estimated.
  const rows = new Map<string, UsageHistoryRow>();
  for (const row of core.journal.usageByBucket(edges)) {
    if (providerId !== undefined && row.provider_id !== providerId) continue;
    const cost = priceGroup(core, row);
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
    // The rate most of the joined writes paid, which neither group alone tells.
    entry.price = priceUsage(entry.model, entry.usage)?.price ?? entry.price ?? cost.price;
  }

  const byThread = new Map<ThreadId, UsageHistoryThread>();
  for (const row of core.journal.usageByThread(edges[0]!, edges[edges.length - 1]!)) {
    if (providerId !== undefined && row.provider_id !== providerId) continue;
    const { usage } = priceGroup(core, row);
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
