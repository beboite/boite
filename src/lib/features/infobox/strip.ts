/**
 * The row the info box lives in, and the popover that hangs off it.
 *
 * The box used to float over the terminal's top-right corner on one of eight
 * docks, which put it over the first four lines of output for the whole
 * session. It is a strip above the terminal now: one row, the width of the
 * column the terminal is drawn in, and the terminal starts under it. There is
 * one position, so the dock and its drag are gone with the geometry that
 * served them.
 *
 * What is left here is what the row cannot express in CSS: the height the
 * terminal has to give up, and where the log popover may sit so it never
 * leaves the column.
 */

/** Height of the strip, px. The terminal below is inset by exactly this. */
export const INFO_BOX_ROW_PX = 32;

/** Width of the log popover, px. Matches the width the card used to have. */
export const INFO_BOX_POPOVER_PX = 320;

/** Gutter from the column edge, px. Matches the 0.75rem the toaster uses. */
export const INFO_BOX_GUTTER_PX = 12;

/** Commits the popover lists. The hover it replaces showed six. */
export const INFO_BOX_LOG = 10;

/**
 * How much room the terminal gives the strip.
 *
 * Zero when nothing is drawn: a pane too narrow for the row, or a project with
 * nothing to say, must not lose 32 px to a strip that never appears.
 */
export function infoBoxInset(shown: boolean): number {
  return shown ? INFO_BOX_ROW_PX : 0;
}

/**
 * Left of the popover inside the column, given where its trigger sits.
 *
 * Aligned on the trigger, then pushed back inside: the commit cell is at the
 * right end of a strip that is often narrower than the popover, and a popover
 * anchored honestly to it would hang over the pane beside this one. A column
 * narrower than the popover pins it to the left gutter rather than centring a
 * box that does not fit.
 */
export function popoverLeft(
  columnWidth: number,
  popoverWidth: number,
  anchorX: number,
  gutter: number = INFO_BOX_GUTTER_PX,
): number {
  const max = columnWidth - popoverWidth - gutter;
  if (max <= gutter) return gutter;
  return Math.min(max, Math.max(gutter, anchorX));
}
