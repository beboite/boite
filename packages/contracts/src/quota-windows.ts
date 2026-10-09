/**
 * What a limit window measures, read from its id and label so native readings
 * and a gateway's agree: a few hours (Claude's five-hour session), a day, a
 * week, a month, one model's own allowance, or anything else.
 */
export const QUOTA_WINDOW_KINDS = ['hours', 'daily', 'weekly', 'monthly', 'model', 'other'] as const;
export type QuotaWindowKind = (typeof QUOTA_WINDOW_KINDS)[number];

export function quotaWindowKind(window: { id: string; label: string }): QuotaWindowKind {
  const id = window.id.toLowerCase();
  const text = `${id} ${window.label.toLowerCase()}`;
  // Claude's per-model weeks: `seven_day_opus` natively, `seven-day-opus` from Douane, `model:` for model_scoped.
  if (id.startsWith('model:') || /^seven[-_]day[-_]./.test(id)) return 'model';
  // Weeks first: `seven-day` also says "day".
  if (/week|seven|\b7 ?d\b/.test(text)) return 'weekly';
  if (/month/.test(text)) return 'monthly';
  if (/daily|\bday\b|\b24 ?(h\b|hours?)/.test(text)) return 'daily';
  if (/\d ?(h\b|hours?)|five|session/.test(text)) return 'hours';
  return 'other';
}
