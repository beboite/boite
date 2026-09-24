import { describe, expect, test } from 'vitest';
import type { PromptCache } from '@boite/contracts';
import { cacheMinutes, cacheSpan, promptCacheState } from './prompt-cache';

const thread = { model: 'claude-opus-5', accountId: 'a-claude' };
const cache: PromptCache = { at: 0, ttlSeconds: 3600, source: 'reported', readTokens: 0, ...thread };

describe('promptCacheState', () => {
  test('counts down the lifetime from the end of the last turn', () => {
    expect(promptCacheState(cache, thread, 29 * 60_000)).toEqual({ kind: 'warm', secondsLeft: 31 * 60 });
    expect(promptCacheState(cache, thread, 3600_000)).toEqual({ kind: 'cold', switched: false });
  });

  test('past the promised lifetime, a best-effort ceiling reads maybe', () => {
    const openai: PromptCache = { ...cache, ttlSeconds: 300, maxSeconds: 3600, source: 'documented' };
    expect(promptCacheState(openai, thread, 10 * 60_000)).toEqual({ kind: 'maybe', secondsLeft: 50 * 60 });
    expect(promptCacheState(openai, thread, 61 * 60_000).kind).toBe('cold');
  });

  test('another model or account starts cold, whatever the clock says', () => {
    expect(promptCacheState(cache, { ...thread, model: 'claude-sonnet-5' }, 1000)).toEqual({ kind: 'cold', switched: true });
    expect(promptCacheState(cache, { ...thread, accountId: 'a-other' }, 1000)).toEqual({ kind: 'cold', switched: true });
  });

  test('a clock behind the stamp does not add time', () => {
    expect(promptCacheState(cache, thread, -5000)).toEqual({ kind: 'warm', secondsLeft: 3600 });
  });
});

test('cacheMinutes rounds up and never reads zero', () => {
  expect(cacheMinutes(40)).toBe(1);
  expect(cacheMinutes(61)).toBe(2);
  expect(cacheMinutes(1860)).toBe(31);
});

test('cacheSpan switches to whole hours past the hour', () => {
  expect(cacheSpan(1860)).toEqual({ unit: 'minutes', n: 31 });
  expect(cacheSpan(3540)).toEqual({ unit: 'minutes', n: 59 });
  expect(cacheSpan(3570)).toEqual({ unit: 'hours', n: 1 });
  expect(cacheSpan(84_000)).toEqual({ unit: 'hours', n: 23 });
});
