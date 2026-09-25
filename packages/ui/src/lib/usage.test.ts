import { describe, expect, test } from 'vitest';
import type { Usage, UsageHistory, UsageHistoryRow } from '@boite/contracts';
import { fakeUsageHistory } from './fake-usage';
import { setLocaleSetting } from './i18n.svelte';
import { dayEdges, formatMetric, formatTick, niceScale, seriesFor, summarize, topThreads } from './usage';

function usage(inputTokens: number, outputTokens: number, cost: number | null = null): Usage {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: cost };
}

function row(bucket: number, providerId: string, model: string | null, turns: number, spent: Usage, priced = spent.costUsdEquivalent === null ? 0 : turns): UsageHistoryRow {
  return { bucket, providerId, model, turns, reported: turns, priced, usage: spent };
}

describe('dayEdges', () => {
  test('are local midnights, one per day, the last one after now', () => {
    const now = new Date(2026, 2, 29, 15, 30).getTime();
    const edges = dayEdges(7, now);
    expect(edges).toHaveLength(8);
    for (const edge of edges) expect(new Date(edge).getHours()).toBe(0);
    expect(edges.map((edge) => new Date(edge).getDate())).toEqual([23, 24, 25, 26, 27, 28, 29, 30]);
    expect(edges[6]!).toBeLessThanOrEqual(now);
    expect(edges[7]!).toBeGreaterThan(now);
  });
});

describe('niceScale', () => {
  test('steps on 1, 2 or 5 up to the first tick over the peak', () => {
    expect(niceScale(130).ticks).toEqual([0, 50, 100, 150]);
    expect(niceScale(0.37).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceScale(2_400_000).ticks).toEqual([0, 1_000_000, 2_000_000, 3_000_000]);
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });

  test('keeps a count of turns on whole numbers', () => {
    expect(niceScale(3, 4, 1).ticks).toEqual([0, 1, 2, 3]);
  });
});

describe('seriesFor', () => {
  test('keeps the fixed provider order, gives two spare slots, and folds the rest', () => {
    const { series, keyOf } = seriesFor(['zeta', 'codex', 'alpha', 'claude', 'beta']);
    expect(series.map((serie) => [serie.key, serie.color])).toEqual([
      ['claude', 'var(--series-1)'],
      ['codex', 'var(--series-2)'],
      ['alpha', 'var(--series-7)'],
      ['beta', 'var(--series-8)'],
      ['other', 'var(--series-other)']
    ]);
    expect(keyOf('zeta')).toBe('other');
  });

  test('a provider keeps its colour when others leave the range', () => {
    const wide = seriesFor(['claude', 'codex', 'grok']).series.find((serie) => serie.key === 'grok');
    const narrow = seriesFor(['grok']).series.find((serie) => serie.key === 'grok');
    expect(narrow?.color).toBe(wide?.color);
  });
});

describe('summarize', () => {
  const history: UsageHistory = {
    edges: [0, 10, 20, 30],
    rows: [
      row(0, 'codex', 'gpt', 2, usage(100, 50)),
      row(0, 'claude', 'opus', 1, usage(10, 10, 0.5)),
      row(2, 'claude', 'opus', 3, usage(30, 30, 1.5)),
      row(2, 'claude', null, 1, usage(5, 5, 0.1))
    ],
    threads: []
  };

  test('stacks each bucket by provider in the chosen measure', () => {
    const view = summarize(history, 'tokens');
    expect(view.series.map((serie) => serie.key)).toEqual(['claude', 'codex']);
    expect(view.buckets.map((bucket) => bucket.values)).toEqual([{ claude: 20, codex: 150 }, { claude: 0, codex: 0 }, { claude: 70, codex: 0 }]);
    expect(view.total.value).toBe(240);
    expect(view.bySeries['claude']?.turns).toBe(5);
  });

  test('costs only what was priced and names the providers with no price', () => {
    const view = summarize(history, 'cost');
    expect(view.total.value).toBeCloseTo(2.1);
    expect(view.bySeries['codex']?.priced).toBe(0);
    expect(view.unpriced).toEqual(['codex']);
  });

  test('breaks down by model, largest first, and by day, newest first', () => {
    const view = summarize(history, 'turns');
    expect(view.models.map((model) => [model.providerId, model.model, model.value])).toEqual([
      ['claude', 'opus', 4],
      ['codex', 'gpt', 2],
      ['claude', null, 1]
    ]);
    expect(view.days.map((day) => [day.start, day.turns])).toEqual([[20, 4], [10, 0], [0, 3]]);
  });

  test('ranks threads by the measure and drops the ones with nothing', () => {
    const threads = [
      { threadId: 'a', title: 'A', projectId: 'p', providerId: 'claude', archived: false, turns: 9, usage: usage(10, 0, 0.1) },
      { threadId: 'b', title: 'B', projectId: 'p', providerId: 'codex', archived: false, turns: 2, usage: usage(900, 0) }
    ];
    expect(topThreads(threads, 'turns').map((thread) => thread.threadId)).toEqual(['a', 'b']);
    expect(topThreads(threads, 'tokens').map((thread) => thread.threadId)).toEqual(['b', 'a']);
    expect(topThreads(threads, 'cost').map((thread) => thread.threadId)).toEqual(['a']);
  });
});

describe('formatMetric', () => {
  test('reads tokens like the context meter, money in dollars, turns whole', () => {
    expect(formatMetric('tokens', 84_400)).toBe('84k');
    expect(formatMetric('tokens', 1_240_000)).toBe('1.2M');
    expect(formatMetric('tokens', 3_400_000_000)).toBe('3.4B');
    expect(formatMetric('turns', 1234)).toBe('1,234');
    expect(formatMetric('cost', 12.5)).toBe('$12.50');
    expect(formatMetric('cost', 0.004)).toBe('$0.004');
    expect(formatMetric('cost', 2345.6)).toBe('$2,346');
    expect(formatMetric('cost', 12_400)).toBe('$12.4k');
    expect(formatTick('cost', 2.5)).toBe('$2.5');
    expect(formatTick('cost', 1500)).toBe('$1.5k');
  });

  test('writes counts and money the way the language the app speaks does', () => {
    setLocaleSetting('fr');
    try {
      const plain = (text: string) => text.replace(/\s/g, ' ');
      expect(plain(formatMetric('turns', 1594))).toBe('1 594');
      expect(plain(formatMetric('cost', 113.23))).toBe('113,23 $US');
      expect(plain(formatMetric('cost', 12_400))).toBe('12,4k $US');
      expect(plain(formatTick('cost', 2.5))).toBe('2,5 $US');
    } finally { setLocaleSetting('en'); }
  });
});

describe('the fake ledger', () => {
  const now = new Date(2026, 8, 18, 16, 0).getTime();
  const edges = dayEdges(90, now);

  test('draws the same days every time, from several providers', () => {
    const first = fakeUsageHistory(edges, { seeded: true, finished: [], now });
    expect(fakeUsageHistory(edges, { seeded: true, finished: [], now })).toEqual(first);
    expect(new Set(first.rows.map((entry) => entry.providerId))).toEqual(new Set(['claude', 'codex', 'opencode', 'grok', 'antigravity', 'pi']));
    expect(first.rows.every((entry) => entry.bucket >= 0 && entry.bucket < 90)).toBe(true);
    expect(first.rows.filter((entry) => entry.providerId === 'codex').every((entry) => entry.usage.costUsdEquivalent === null && entry.priced === 0)).toBe(true);
    expect(first.rows.some((entry) => entry.reported < entry.turns)).toBe(true);
  });

  test('adds the turns this session finished and is empty on a fresh machine', () => {
    const turn = { at: now - 60_000, threadId: 't-new', title: 'New', projectId: 'p', providerId: 'echo', model: null, usage: usage(4, 4, 0.01) };
    const history = fakeUsageHistory(edges, { seeded: false, finished: [turn], now });
    expect(history.rows).toEqual([{ bucket: 89, providerId: 'echo', model: null, turns: 1, reported: 1, priced: 1, usage: usage(4, 4, 0.01) }]);
    expect(history.threads.map((thread) => thread.threadId)).toEqual(['t-new']);
  });
});
