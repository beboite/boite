/*
 * The prompt cache lifetimes the providers publish, for the drivers whose
 * agent does not report one per request. `docs/prompt-cache.md` has the
 * sources and what each agent sends; a provider missing here has no published
 * lifetime, and its threads show no timer rather than a guess. Also the cache
 * a finished turn leaves on its thread (`promptCacheOf`).
 */

import type { PromptCache, ThreadSummary } from '@boite/contracts';
import type { PromptCacheLife, TurnResult } from './drivers/types.ts';

/**
 * Anthropic's default lifetime, what a `cache_control` with no `ttl` asks
 * for. Each hit restarts it.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
export const ANTHROPIC_DEFAULT: PromptCacheLife = { ttlSeconds: 300, source: 'documented' };

const OPENAI_MODEL = /^(?:[a-z0-9-]+\/)?gpt-(\d+)(?:\.(\d+))?/i;

/**
 * OpenAI's lifetime for a request that sets no retention option, which is
 * what Codex, OpenCode and pi's default send. From GPT-5.6 on, a prefix stays
 * 30 minutes after its last write or reuse. Before it, an organization
 * without Zero Data Retention defaults to the extended retention, "around 30
 * minutes", up to 24 hours. A ZDR organization falls back to 5 to 10 minutes,
 * which the core cannot see: the docs say so. Null for a model that is not a
 * `gpt-N` one.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 */
export function openAiCacheLife(model: string | null): PromptCacheLife | null {
  const match = model === null ? null : OPENAI_MODEL.exec(model);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (major > 5 || (major === 5 && minor >= 6)) return { ttlSeconds: 1800, source: 'documented' };
  return { ttlSeconds: 1800, maxSeconds: 86_400, source: 'documented' };
}

/**
 * The prompt cache a finished turn left, or null when the driver names no
 * lifetime or nothing shows a request went out: a turn stopped before its
 * first call reported no usage and touched no cache. A lifetime that is not a
 * whole positive number of seconds is dropped, never shown.
 */
export function promptCacheOf(
  result: TurnResult,
  thread: Pick<ThreadSummary, 'model' | 'accountId'>,
  at: number,
  previous: PromptCache | null = null,
): PromptCache | null {
  // A turn that only read from the cache restarts the clock of the lifetime
  // the earlier write had, as long as it ran on the same model and account.
  const reread = (result.usage?.cacheReadTokens ?? 0) > 0 && previous !== null
    && previous.model === thread.model && previous.accountId === thread.accountId ? previous : null;
  const life = result.promptCache ?? reread;
  if (!life || (result.usage === null && result.status !== 'done')) return null;
  if (!Number.isInteger(life.ttlSeconds) || life.ttlSeconds <= 0) return null;
  const max = life.maxSeconds !== undefined && Number.isInteger(life.maxSeconds) && life.maxSeconds > life.ttlSeconds ? life.maxSeconds : undefined;
  return {
    at,
    ttlSeconds: life.ttlSeconds,
    ...(max === undefined ? {} : { maxSeconds: max }),
    source: life.source,
    readTokens: result.usage?.cacheReadTokens ?? 0,
    model: thread.model,
    accountId: thread.accountId,
  };
}
