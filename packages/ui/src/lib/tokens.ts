import type { AutoCompact, ContextUse } from '@boite/contracts';

/** Available capacity ends at the compaction threshold or the smaller model window. */
export function contextLimit(context: ContextUse, autoCompact?: AutoCompact | null): number | null {
  const window = context.window !== null && context.window > 0 ? context.window : null;
  const threshold = autoCompact?.tokens ?? null;
  return threshold === null ? window : window === null ? threshold : Math.min(window, threshold);
}

/** The meter's percentage, whole, capped at 100. Null without a known limit. */
export function contextPercent(context: ContextUse, autoCompact?: AutoCompact | null): number | null {
  const limit = contextLimit(context, autoCompact);
  return limit === null ? null : Math.min(100, Math.round((context.tokens / limit) * 100));
}

/** Which colour the meter wears: `high` past three quarters, `full` past nine tenths. */
export function contextLevel(percent: number | null): 'low' | 'high' | 'full' {
  if (percent === null || percent < 75) return 'low';
  return percent < 90 ? 'high' : 'full';
}
