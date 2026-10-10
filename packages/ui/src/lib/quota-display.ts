import type { AccountQuota, QuotaWindow } from '@boite/contracts';

export interface ShownWindows {
  /** Shown first and largest, with its reset. Null when the reading has no window. */
  primary: QuotaWindow | null;
  /** The other windows, in the reading's order. */
  others: QuotaWindow[];
}

/**
 * A window over the whole account for a week: Claude's `seven_day`, Codex's
 * weekly window, Douane's `seven-day`. A per-model one (`seven-day-opus`,
 * `model:...`) is not.
 */
function weekly(window: QuotaWindow): boolean {
  const id = window.id.toLowerCase();
  if (id.startsWith('model:') || /^seven[-_]day[-_]./.test(id)) return false;
  return /week|seven|\b7\s*-?d/.test(`${id} ${window.label.toLowerCase()}`);
}

/**
 * The window Douane flagged primary, else the weekly one, else the first.
 * Which windows a Douane account sends is chosen in Douane, per provider.
 */
export function shownWindows(row: AccountQuota): ShownWindows {
  const primary = row.windows.find((window) => window.primary)
    ?? row.windows.find(weekly) ?? row.windows[0] ?? null;
  return { primary, others: row.windows.filter((window) => window !== primary) };
}
