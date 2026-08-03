import type { RightPanelTab } from "$lib/types";

/**
 * The two decisions the docked column makes about itself: how wide it may be,
 * and what a stored per-project blob is allowed to say.
 *
 * Out here rather than in the settings store because both are pure, and the
 * store reaches the backend, the database and the notification host the moment
 * it is imported — which is the whole reason neither of these had a test.
 */

export function isRightPanelTab(value: unknown): value is RightPanelTab {
  return value === "git" || value === "explorer" || value === "todo" || value === null;
}

/** Drops any entry a build change (or a hand-edited blob) left unreadable,
    rather than letting one bad key open a column on nothing. */
export function readRightPanelMap(value: unknown): Record<string, RightPanelTab> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, RightPanelTab> = {};
  for (const [id, tab] of Object.entries(value as Record<string, unknown>)) {
    if (isRightPanelTab(tab)) out[id] = tab;
  }
  return out;
}

export const RIGHT_PANEL_MIN_WIDTH = 240;
export const RIGHT_PANEL_MAX_WIDTH = 600;
/** No more than this much of the window, whatever was stored. */
export const RIGHT_PANEL_MAX_FRACTION = 0.4;

/**
 * The column's width, kept to something the window can actually spare.
 *
 * The stored width is per machine and outlives the window it was chosen in: a
 * 600px column dragged out on a wide monitor came back on a laptop as most of
 * the app, with the terminal it exists beside squeezed into what was left.
 *
 * The floor wins over the fraction on purpose. A column narrower than its own
 * content is not a smaller column, it is an unreadable one, and a window too
 * narrow to hold 240px beside a terminal is a window whose answer is to close
 * the column rather than to shrink it to nothing.
 */
export function clampRightPanelWidth(px: number, viewportWidth?: number): number {
  const viewport =
    viewportWidth ?? (typeof window === "undefined" ? Infinity : window.innerWidth);
  const ceiling = Math.min(
    RIGHT_PANEL_MAX_WIDTH,
    Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(viewport * RIGHT_PANEL_MAX_FRACTION)),
  );
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(ceiling, Math.round(px)));
}
