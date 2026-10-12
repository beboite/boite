import type { ContextUse } from '@boite/contracts';

/** The meter's percentage, whole, capped at 100. Null when the agent named no window. */
export function contextPercent(context: ContextUse): number | null {
  if (context.window === null || context.window <= 0) return null;
  return Math.min(100, Math.round((context.tokens / context.window) * 100));
}

/** Which colour the meter wears: `high` past three quarters, `full` past nine tenths. */
export function contextLevel(percent: number | null): 'low' | 'high' | 'full' {
  if (percent === null || percent < 75) return 'low';
  return percent < 90 ? 'high' : 'full';
}
