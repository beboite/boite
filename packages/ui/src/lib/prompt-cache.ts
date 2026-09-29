/*
 * The prompt cache timer, behind the `prompt-cache` experiment. The core
 * stamps `ThreadSummary.promptCache` at the end of every turn whose provider
 * lifetime is known; this module turns it and the clock into what the header
 * shows. `docs/prompt-cache.md` has the lifetimes and their sources.
 */

import type { PromptCache, ThreadSummary } from '@boite/contracts';

export type PromptCacheState =
  /** Inside the lifetime the provider promises. */
  | { kind: 'warm'; secondsLeft: number }
  /** Past the promised lifetime, still inside what the provider may keep on a best-effort basis. */
  | { kind: 'maybe'; secondsLeft: number }
  /** Expired, or the thread moved to another model or account since. */
  | { kind: 'cold'; switched: boolean };

export function promptCacheState(
  cache: PromptCache,
  thread: Pick<ThreadSummary, 'model' | 'accountId'>,
  now: number
): PromptCacheState {
  if (cache.model !== thread.model || cache.accountId !== thread.accountId) return { kind: 'cold', switched: true };
  const elapsed = Math.max(0, (now - cache.at) / 1000);
  if (elapsed < cache.ttlSeconds) return { kind: 'warm', secondsLeft: Math.ceil(cache.ttlSeconds - elapsed) };
  if (cache.maxSeconds !== undefined && elapsed < cache.maxSeconds) {
    return { kind: 'maybe', secondsLeft: Math.ceil(cache.maxSeconds - elapsed) };
  }
  return { kind: 'cold', switched: false };
}

/** Whole minutes, rounded up: a cache with 40 seconds left reads `1m`, never `0m`. */
export function cacheMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/** What is left, in minutes under an hour and in whole hours past it: `23 h`, never `1400 min`. */
export function cacheSpan(seconds: number): { unit: 'minutes' | 'hours'; n: number } {
  const minutes = cacheMinutes(seconds);
  return minutes < 60 ? { unit: 'minutes', n: minutes } : { unit: 'hours', n: Math.round(minutes / 60) };
}

/** How often the header re-reads the clock: the label moves by the minute. */
export const PROMPT_CACHE_TICK_MS = 15_000;
