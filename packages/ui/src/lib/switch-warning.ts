import type { ThreadSummary } from '@boite/contracts';

/** Past this many tokens a thread holds far more than a new session is handed. */
export const SWITCH_WARNING_TOKENS = 200_000;

/** Past this many tokens one uncached turn costs as much quota as a dozen cached ones. */
export const CACHE_WARNING_TOKENS = 100_000;

/** The longest a provider keeps a prompt cache (Claude's one-hour tier). An older reading has nothing left to lose. */
export const CACHE_LIFETIME_MS = 60 * 60 * 1000;

/** What a provider keys its prompt cache on, besides the conversation itself. */
export interface CacheKey {
  accountId: string;
  model: string | null;
  effort: string | null;
  speed: string | null;
}

/**
 * Another account means a new native session, which receives bounded excerpts
 * of the conversation (`docs/model-switching.md`), not what the old one held.
 * On a long thread that is most of it, so the user is asked first.
 */
export function switchDropsHistory(thread: Pick<ThreadSummary, 'accountId' | 'context'>, accountId: string): boolean {
  return accountId !== thread.accountId && (thread.context?.tokens ?? 0) > SWITCH_WARNING_TOKENS;
}

/**
 * Within one account the session survives a change of model, effort or speed,
 * but the provider's prompt cache may not: measured on 2026-09-22, a model
 * change misses on Claude, and an effort change misses on Codex at every level
 * and on Claude Sonnet 5 (`docs/model-switching.md`). The next turn then sends
 * the whole thread uncached, so a long thread with a warm cache asks first.
 */
export function switchResetsCache(thread: Pick<ThreadSummary, 'context'>, from: CacheKey, to: CacheKey, now = Date.now()): boolean {
  const context = thread.context;
  if (!context || context.tokens <= CACHE_WARNING_TOKENS || now - context.at >= CACHE_LIFETIME_MS) return false;
  if (from.accountId !== to.accountId) return false;
  return from.model !== to.model || from.effort !== to.effort || from.speed !== to.speed;
}
