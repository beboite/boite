import type { Core } from '../core.ts';
import { priceGroup } from '../usage.ts';

/** What a bot spent: `costUsd` in API-equivalent dollars, and the turns nothing could price. */
export interface AgentSpend {
  costUsd: number;
  /**
   * Turns that reported tokens on a model the price list does not know and
   * reported no cost of their own: they add nothing to `costUsd`, so a bot
   * that only runs such turns never reaches its budget.
   */
  unpriced: number;
}

/**
 * The only reader of a bot's spend, for its daily budget and its status:
 * the turns started since `sinceMs` on its thread and every thread below it
 * (subagents at any depth, workflow steps, the memory pass), each priced
 * with the rule of the usage page (`priceGroup`): the model's public rates
 * first, else the cost the agent reported.
 */
export function agentSpend(core: Core, botThreadId: string, sinceMs: number): AgentSpend {
  let costUsd = 0;
  let unpriced = 0;
  for (const row of core.journal.usageOfTree(botThreadId, sinceMs)) {
    const { usage, priced } = priceGroup(core, row, row.provider_id, row.model);
    costUsd += usage.costUsdEquivalent ?? 0;
    unpriced += row.reported - priced;
  }
  return { costUsd, unpriced };
}

/** The thread at the top of `threadId`'s parents: the bot's own thread for a subagent of a bot. */
export function rootThread(core: Core, threadId: string): string {
  const seen = new Set<string>([threadId]);
  let id = threadId;
  for (let parent = core.journal.getThread(id)?.parentThreadId; parent && !seen.has(parent); parent = core.journal.getThread(id)?.parentThreadId) {
    seen.add(parent);
    id = parent;
  }
  return id;
}
