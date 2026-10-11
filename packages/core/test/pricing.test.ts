import { expect, test } from 'bun:test';
import list from '../src/pricing/rates.json';
import { costAt, priceOf } from '../src/pricing/index.ts';

test('a model id resolves through provider prefixes, effort and date suffixes and context tags', () => {
  for (const id of ['claude-opus-5-5', 'claude/claude-opus-5-5', 'antigravity/claude-opus-5-5-high', 'anthropic.claude-opus-5-5', 'claude-opus-5-5@20260922', 'claude-opus-5-5[1m]', 'Claude-Opus-5-5', 'claude-opus-5-5-20260922-xhigh']) {
    expect(priceOf(id)?.model).toBe('claude-opus-5-5');
  }
  expect(priceOf('codex/gpt-6.1-sol')?.name).toBe('GPT-6.1 Sol');
  // A Codex build is priced as its model; a smaller variant is not.
  expect(priceOf('gpt-5.1-codex-max')?.model).toBe('gpt-5.1');
  expect(priceOf('gpt-5.1-codex-mini')?.model).not.toBe('gpt-5.1');
  for (const id of [null, '', '  ', 'default', 'house-model']) expect(priceOf(id)).toBeNull();
});

test('Claude Code writes an hour of cache at twice the input rate, other harnesses and makers keep the listed rate', () => {
  const listed = list.models['claude-opus-5-5'];
  expect(priceOf('claude-opus-5-5')?.rates).toEqual({ input: listed.input, output: listed.output, cacheRead: listed.cacheRead!, cacheWrite: listed.cacheWrite! });
  expect(priceOf('claude-opus-5-5', true)?.rates.cacheWrite).toBe(listed.input * 2);
  expect(priceOf('gpt-6.1-sol', true)?.rates.cacheWrite).toBe(list.models['gpt-6.1-sol'].cacheWrite!);
});

test('a rate the list leaves out is charged at the input rate', () => {
  const [id, entry] = Object.entries(list.models as Record<string, { input: number; cacheRead: number | null; cacheWrite: number | null }>).find(([, model]) => model.cacheRead === null && model.cacheWrite === null)!;
  expect(priceOf(id)?.rates).toMatchObject({ cacheRead: entry.input, cacheWrite: entry.input });
});

test('the cost is each token kind at its rate per million', () => {
  const rates = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 };
  expect(costAt(rates, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null })).toBe(4);
  expect(costAt(rates, { inputTokens: 500, outputTokens: 1_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 250_000, costUsdEquivalent: 99 })).toBeCloseTo(0.002 + 0.02 + 0.4 + 2, 10);
});

test('the price list covers the major makers with usable rates', () => {
  const models = Object.values(list.models as Record<string, { maker: string; input: number; output: number; cacheRead: number | null; cacheWrite: number | null }>);
  for (const maker of ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai', 'zai', 'mistral', 'alibaba', 'meta']) {
    expect(models.some((model) => model.maker === maker)).toBe(true);
  }
  for (const model of models) {
    for (const rate of [model.input, model.output, model.cacheRead ?? 0, model.cacheWrite ?? 0]) expect(Number.isFinite(rate) && rate >= 0).toBe(true);
  }
});
