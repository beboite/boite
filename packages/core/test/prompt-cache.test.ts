import { describe, expect, test } from 'bun:test';
import type { PromptCache, Usage } from '@boite/contracts';
import { cacheLifeOf } from '../src/drivers/claude.ts';
import { acpCacheLife } from '../src/drivers/acp.ts';
import { piCacheLife } from '../src/drivers/pi.ts';
import { openAiCacheLife } from '../src/prompt-cache.ts';
import { promptCacheOf } from '../src/threads.ts';

describe('openAiCacheLife', () => {
  test('GPT-5.6 and later keep a prefix 30 minutes after its last use', () => {
    expect(openAiCacheLife('gpt-5.6')).toEqual({ ttlSeconds: 1800, source: 'documented' });
    expect(openAiCacheLife('gpt-6-astra')).toEqual({ ttlSeconds: 1800, source: 'documented' });
    expect(openAiCacheLife('openai/gpt-6-astra')).toEqual({ ttlSeconds: 1800, source: 'documented' });
  });

  test('earlier models get the extended default, about 30 minutes and up to a day', () => {
    expect(openAiCacheLife('gpt-5.5')).toEqual({ ttlSeconds: 1800, maxSeconds: 86_400, source: 'documented' });
    expect(openAiCacheLife('gpt-5-codex')).toEqual({ ttlSeconds: 1800, maxSeconds: 86_400, source: 'documented' });
    expect(openAiCacheLife('gpt-4.1')).toEqual({ ttlSeconds: 1800, maxSeconds: 86_400, source: 'documented' });
  });

  test('a model that is not gpt-N has no published lifetime', () => {
    expect(openAiCacheLife('gpt-oss-120b')).toBeNull();
    expect(openAiCacheLife('o3')).toBeNull();
    expect(openAiCacheLife(null)).toBeNull();
  });
});

describe('piCacheLife', () => {
  const anthropic = { api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-5' };

  test('reads the one-hour split pi passes through from Anthropic', () => {
    expect(piCacheLife({ ...anthropic, usage: { cacheWrite: 900, cacheWrite1h: 900 } })).toEqual({ ttlSeconds: 3600, source: 'reported' });
    expect(piCacheLife({ ...anthropic, usage: { cacheWrite: 900, cacheWrite1h: 0 } })).toEqual({ ttlSeconds: 300, source: 'reported' });
  });

  test('an Anthropic request that wrote nothing names nothing, an older pi gets the default', () => {
    expect(piCacheLife({ ...anthropic, usage: { cacheRead: 5000, cacheWrite: 0, cacheWrite1h: 0 } })).toBeNull();
    expect(piCacheLife({ ...anthropic, usage: { cacheWrite: 900 } })).toEqual({ ttlSeconds: 300, source: 'documented' });
  });

  test('OpenAI through pi follows the model, other vendors have no lifetime', () => {
    expect(piCacheLife({ api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6-astra', usage: {} })?.ttlSeconds).toBe(1800);
    expect(piCacheLife({ api: 'openai-responses', provider: 'openrouter', model: 'gpt-5.5', usage: {} })).toBeNull();
    expect(piCacheLife({ api: 'google-generative-ai', provider: 'google', model: 'gemini-3.1-pro', usage: {} })).toBeNull();
  });
});

describe('acpCacheLife', () => {
  test('OpenCode names the vendor in its model id', () => {
    expect(acpCacheLife('opencode', 'anthropic/claude-sonnet-5')).toEqual({ ttlSeconds: 300, source: 'documented' });
    expect(acpCacheLife('opencode', 'openai/gpt-6-astra')?.ttlSeconds).toBe(1800);
    expect(acpCacheLife('opencode', 'opencode/claude-sonnet-5')).toBeNull();
    expect(acpCacheLife('opencode', null)).toBeNull();
  });

  test('Grok and Antigravity publish no lifetime', () => {
    expect(acpCacheLife('grok', 'grok-5')).toBeNull();
    expect(acpCacheLife('antigravity', 'gemini-3.8-flash')).toBeNull();
  });
});

const usage = (cacheReadTokens: number): Usage => ({ inputTokens: 10, outputTokens: 5, cacheReadTokens, cacheWriteTokens: 0, costUsdEquivalent: null });
const thread = { model: 'claude-opus-5', accountId: 'a-claude' };

describe('cacheLifeOf', () => {
  test('reads the lifetime from the split the Messages API reports', () => {
    expect(cacheLifeOf({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2263 } }))
      .toEqual({ ttlSeconds: 3600, source: 'reported' });
    expect(cacheLifeOf({ cache_creation: { ephemeral_5m_input_tokens: 812, ephemeral_1h_input_tokens: 0 } }))
      .toEqual({ ttlSeconds: 300, source: 'reported' });
  });

  test('a request writing at both lifetimes is as warm as the shorter', () => {
    expect(cacheLifeOf({ cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 9000 } })?.ttlSeconds).toBe(300);
  });

  test('a request that wrote nothing, or an older CLI without the split, names no lifetime', () => {
    expect(cacheLifeOf({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })).toBeNull();
    expect(cacheLifeOf({ cache_creation_input_tokens: 500 })).toBeNull();
    expect(cacheLifeOf(undefined)).toBeNull();
  });
});

describe('promptCacheOf', () => {
  test('stamps the lifetime with the time, the model and the account', () => {
    const cache = promptCacheOf({ status: 'done', sessionId: 's', usage: usage(1200), promptCache: { ttlSeconds: 3600, source: 'reported' } }, thread, 1000);
    expect(cache).toEqual({ at: 1000, ttlSeconds: 3600, source: 'reported', readTokens: 1200, model: 'claude-opus-5', accountId: 'a-claude' });
  });

  test('keeps a best-effort ceiling only above the lifetime', () => {
    const life = { ttlSeconds: 300, maxSeconds: 3600, source: 'documented' } as const;
    expect(promptCacheOf({ status: 'done', sessionId: 's', usage: usage(0), promptCache: life }, thread, 1)?.maxSeconds).toBe(3600);
    expect(promptCacheOf({ status: 'done', sessionId: 's', usage: usage(0), promptCache: { ...life, maxSeconds: 60 } }, thread, 1)?.maxSeconds).toBeUndefined();
  });

  test('a stopped turn with no usage sent nothing, so it leaves no cache', () => {
    expect(promptCacheOf({ status: 'stopped', sessionId: 's', usage: null, promptCache: { ttlSeconds: 300, source: 'reported' } }, thread, 1)).toBeNull();
  });

  test('drops a lifetime that is not a whole positive number of seconds', () => {
    expect(promptCacheOf({ status: 'done', sessionId: 's', usage: usage(0), promptCache: { ttlSeconds: 0, source: 'reported' } }, thread, 1)).toBeNull();
    expect(promptCacheOf({ status: 'done', sessionId: 's', usage: usage(0), promptCache: { ttlSeconds: Number.NaN, source: 'reported' } }, thread, 1)).toBeNull();
  });

  test('a turn that only read restarts the clock of the earlier lifetime on the same model and account', () => {
    const previous: PromptCache = { at: 1, ttlSeconds: 3600, source: 'reported', readTokens: 0, ...thread };
    expect(promptCacheOf({ status: 'done', sessionId: 's', usage: usage(900), promptCache: null }, thread, 5000, previous))
      .toEqual({ ...previous, at: 5000, readTokens: 900 });
    expect(promptCacheOf({ status: 'done', sessionId: 's', usage: usage(900), promptCache: null }, { ...thread, model: 'claude-sonnet-5' }, 5000, previous)).toBeNull();
    expect(promptCacheOf({ status: 'done', sessionId: 's', usage: usage(0), promptCache: null }, thread, 5000, previous)).toBeNull();
  });
});
