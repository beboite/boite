import type { ContextUse } from '@boite/contracts';

/** `512`, `84k`, `1.2M`: what a token count reads as in a chip. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  const millions = count / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`;
}

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
