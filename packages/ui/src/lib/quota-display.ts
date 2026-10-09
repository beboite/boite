import { quotaWindowKind, type AccountQuota, type QuotaWindow, type Settings } from '@boite/contracts';

/** The owner's choices of what every limit view shows. */
export type QuotaDisplay = Pick<Settings, 'quotaHiddenWindows' | 'quotaPrimary'>;

export interface ShownWindows {
  /** Shown first and largest, with its reset. Null when every window is hidden. */
  primary: QuotaWindow | null;
  /** The rest of the shown windows, in the reading's order. */
  others: QuotaWindow[];
}

/**
 * Douane before beboite/douane#18 repeated Claude's five-hour window as a
 * window labelled `session`: the same reading, under a second name.
 */
function repeated(window: QuotaWindow, windows: QuotaWindow[]): boolean {
  if (window.label.trim().toLowerCase() !== 'session') return false;
  return windows.some((other) => other !== window && other.label.trim().toLowerCase() !== 'session'
    && quotaWindowKind(other) === 'hours' && other.usedPercent === window.usedPercent && other.resetsAt === window.resetsAt);
}

/**
 * The windows an account shows. Hidden kinds leave, except the window the
 * owner pinned on this account. The primary one is that pin, else the weekly
 * window, else the first shown.
 */
export function shownWindows(row: AccountQuota, display?: QuotaDisplay | null): ShownWindows {
  const hidden = new Set(display?.quotaHiddenWindows ?? []);
  const pinned = display?.quotaPrimary?.[row.accountId];
  const shown = row.windows.filter((window) => !repeated(window, row.windows)
    && (window.id === pinned || !hidden.has(quotaWindowKind(window))));
  const primary = shown.find((window) => window.id === pinned)
    ?? shown.find((window) => quotaWindowKind(window) === 'weekly') ?? shown[0] ?? null;
  return { primary, others: shown.filter((window) => window !== primary) };
}

/** The window the owner pinned on this account, while the reading still has it. */
export function pinnedWindow(row: AccountQuota, display?: QuotaDisplay | null): string | null {
  const pinned = display?.quotaPrimary?.[row.accountId];
  return pinned !== undefined && row.windows.some((window) => window.id === pinned) ? pinned : null;
}
