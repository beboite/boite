import type { Usage, UsageHistory, UsageHistoryThread } from '@boite/contracts';
import { strings } from './strings';
import { formatTokens } from './tokens';

export type UsageMetric = 'tokens' | 'cost' | 'turns';
export const USAGE_METRICS: readonly UsageMetric[] = ['tokens', 'cost', 'turns'];
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/**
 * The provider stack, bottom first. Fixed, so a provider keeps its colour and
 * its place whatever the range shows. Two spare slots take any other provider,
 * the rest fold into one grey series.
 */
export const PROVIDER_ORDER = ['claude', 'codex', 'opencode', 'grok', 'antigravity', 'pi'] as const;
const SPARE_SLOTS = ['var(--series-7)', 'var(--series-8)'];
export const OTHER = 'other';

/** Local midnights from `days - 1` days before `now` to the coming one: `days + 1` edges. */
export function dayEdges(days: number, now = Date.now()): number[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const edges: number[] = [];
  for (let index = 0; index <= days; index++) {
    const edge = new Date(start);
    edge.setDate(start.getDate() + index);
    edges.push(edge.getTime());
  }
  return edges;
}

/** Every token the provider processed, cache included. */
export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function measure(metric: UsageMetric, turns: number, usage: Usage): number {
  if (metric === 'turns') return turns;
  if (metric === 'cost') return usage.costUsdEquivalent ?? 0;
  return totalTokens(usage);
}

/**
 * Axis ticks on 1, 2 or 5 steps, from zero to the first tick at or above the
 * peak. `minStep` keeps a count of turns on whole numbers.
 */
export function niceScale(peak: number, count = 4, minStep = 0): { max: number; ticks: number[] } {
  if (!(peak > 0) || !Number.isFinite(peak)) return { max: Math.max(1, minStep), ticks: [0, Math.max(1, minStep)] };
  const raw = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? 10 * magnitude;
  const step = Math.max(nice, minStep);
  const steps = Math.max(1, Math.ceil(peak / step - 1e-9));
  const ticks = Array.from({ length: steps + 1 }, (_, index) => Number((index * step).toPrecision(12)));
  return { max: ticks[ticks.length - 1]!, ticks };
}

/** The context meter's `84k` and `1.2M`, carried on to billions for a long range. */
function tokenCount(value: number): string {
  if (value < 1_000_000_000) return formatTokens(value);
  const billions = value / 1_000_000_000;
  return `${billions < 10 ? billions.toFixed(1) : Math.round(billions)}B`;
}

/*
 * Numbers read the way the rest of the English interface writes them, like
 * `format.cost` and the context meter, whatever the system locale.
 */
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const trimmed = (value: number, digits: number) => String(Number(value.toFixed(digits)));

export function formatMetric(metric: UsageMetric, value: number): string {
  if (metric === 'turns') return whole.format(value);
  if (metric === 'tokens') return tokenCount(value);
  if (value >= 10_000) return `$${trimmed(value / 1000, 1)}k`;
  if (value >= 1000) return `$${whole.format(Math.round(value))}`;
  if (value > 0 && value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** A shorter label for an axis: `2M` rather than `2.0M`, `$2.5`, `$1.5k`. */
export function formatTick(metric: UsageMetric, value: number): string {
  if (metric === 'tokens') return formatMetric(metric, value).replace(/\.0(?=[kMB]$)/, '');
  if (metric !== 'cost') return formatMetric(metric, value);
  if (value >= 1000) return `$${trimmed(value / 1000, 1)}k`;
  return `$${trimmed(value, 3)}`;
}

export interface UsageSeries {
  key: string;
  color: string;
  providerIds: string[];
}

export interface UsageTotals {
  turns: number;
  reported: number;
  priced: number;
  usage: Usage;
}

export interface UsageBucket {
  start: number;
  end: number;
  values: Record<string, number>;
  total: number;
  turns: number;
}

export interface ModelRow extends UsageTotals {
  providerId: string;
  model: string | null;
  value: number;
}

export interface DayRow extends UsageTotals {
  start: number;
  value: number;
}

export interface UsageView {
  series: UsageSeries[];
  buckets: UsageBucket[];
  /** Per series key. */
  bySeries: Record<string, UsageTotals & { value: number }>;
  total: UsageTotals & { value: number };
  models: ModelRow[];
  days: DayRow[];
  /** Providers with turns in the range but no price on any of them. */
  unpriced: string[];
}

function emptyTotals(): UsageTotals {
  return { turns: 0, reported: 0, priced: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null } };
}

function addTotals(into: UsageTotals, turns: number, reported: number, priced: number, usage: Usage): void {
  into.turns += turns;
  into.reported += reported;
  into.priced += priced;
  into.usage.inputTokens += usage.inputTokens;
  into.usage.outputTokens += usage.outputTokens;
  into.usage.cacheReadTokens += usage.cacheReadTokens;
  into.usage.cacheWriteTokens += usage.cacheWriteTokens;
  if (usage.costUsdEquivalent !== null) into.usage.costUsdEquivalent = (into.usage.costUsdEquivalent ?? 0) + usage.costUsdEquivalent;
}

/** Which series each provider draws in, known providers first in their fixed order. */
export function seriesFor(providerIds: Iterable<string>): { series: UsageSeries[]; keyOf: (providerId: string) => string } {
  const present = new Set(providerIds);
  const series: UsageSeries[] = [];
  PROVIDER_ORDER.forEach((providerId, index) => {
    if (present.has(providerId)) series.push({ key: providerId, color: `var(--series-${index + 1})`, providerIds: [providerId] });
  });
  const known = new Set<string>(PROVIDER_ORDER);
  const others = [...present].filter((providerId) => !known.has(providerId)).sort();
  const spare = others.slice(0, SPARE_SLOTS.length);
  spare.forEach((providerId, index) => series.push({ key: providerId, color: SPARE_SLOTS[index]!, providerIds: [providerId] }));
  const folded = others.slice(SPARE_SLOTS.length);
  if (folded.length > 0) series.push({ key: OTHER, color: 'var(--series-other)', providerIds: folded });
  const keys = new Map(series.flatMap((entry) => entry.providerIds.map((providerId) => [providerId, entry.key] as const)));
  return { series, keyOf: (providerId) => keys.get(providerId) ?? OTHER };
}

export function summarize(history: UsageHistory, metric: UsageMetric): UsageView {
  const { series, keyOf } = seriesFor(history.rows.map((row) => row.providerId));
  const buckets: UsageBucket[] = history.edges.slice(0, -1).map((start, index) => ({
    start,
    end: history.edges[index + 1]!,
    values: Object.fromEntries(series.map((entry) => [entry.key, 0])),
    total: 0,
    turns: 0,
  }));
  const bySeries: UsageView['bySeries'] = Object.fromEntries(series.map((entry) => [entry.key, { ...emptyTotals(), value: 0 }]));
  const total = { ...emptyTotals(), value: 0 };
  const models = new Map<string, ModelRow>();
  const days = buckets.map((bucket) => ({ ...emptyTotals(), start: bucket.start, value: 0 }));
  const providers = new Map<string, UsageTotals>();

  for (const row of history.rows) {
    const bucket = buckets[row.bucket];
    if (bucket === undefined) continue;
    const key = keyOf(row.providerId);
    const value = measure(metric, row.turns, row.usage);
    bucket.values[key] = (bucket.values[key] ?? 0) + value;
    bucket.total += value;
    bucket.turns += row.turns;
    const serie = bySeries[key]!;
    addTotals(serie, row.turns, row.reported, row.priced, row.usage);
    serie.value += value;
    addTotals(total, row.turns, row.reported, row.priced, row.usage);
    total.value += value;
    const modelKey = `${row.providerId}\u0000${row.model ?? ''}`;
    const model = models.get(modelKey) ?? { ...emptyTotals(), providerId: row.providerId, model: row.model, value: 0 };
    addTotals(model, row.turns, row.reported, row.priced, row.usage);
    model.value += value;
    models.set(modelKey, model);
    const day = days[row.bucket]!;
    addTotals(day, row.turns, row.reported, row.priced, row.usage);
    day.value += value;
    const provider = providers.get(row.providerId) ?? emptyTotals();
    addTotals(provider, row.turns, row.reported, row.priced, row.usage);
    providers.set(row.providerId, provider);
  }

  const unpriced = [...providers].filter(([, totals]) => totals.turns > 0 && totals.priced === 0).map(([providerId]) => providerId);
  return {
    series,
    buckets,
    bySeries,
    total,
    models: [...models.values()].sort((a, b) => b.value - a.value || b.turns - a.turns),
    days: days.reverse(),
    unpriced,
  };
}

/** The threads that spent the most by this metric, largest first. */
export function topThreads(threads: UsageHistoryThread[], metric: UsageMetric, limit = 10): (UsageHistoryThread & { value: number })[] {
  return threads
    .map((thread) => ({ ...thread, value: measure(metric, thread.turns, thread.usage) }))
    .filter((thread) => thread.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/** A readable name for a model id, from the provider's catalogue when it has one. */
export function modelName(model: string | null, names: Map<string, string>): string {
  if (model === null) return strings.usage.defaultModel;
  return names.get(model) ?? model;
}
