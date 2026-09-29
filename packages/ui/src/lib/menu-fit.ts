/**
 * Where a list that pops over its anchor fits: above it when there is room,
 * below it when above is short and below is roomier, and never taller than
 * the space it gets. The composer's menus open upwards, and in the centred
 * draft on a 768 px laptop screen a 420 px list ran off the top of the window.
 */
export interface MenuFit {
  below: boolean;
  maxHeight: number;
}

/** Pixels between the anchor and the list, and between the list and the edge it stops at. */
export const MENU_GAP = 6;
export const MENU_MARGIN = 8;
/** Above this much room the list stays above, whatever is below. */
export const MENU_MIN_ABOVE = 200;

export function fitMenu(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  topInset: number,
  cap: number
): MenuFit {
  const above = Math.floor(anchor.top - topInset - MENU_GAP - MENU_MARGIN);
  const below = Math.floor(viewportHeight - anchor.bottom - MENU_GAP - MENU_MARGIN);
  if (above >= MENU_MIN_ABOVE || above >= below) return { below: false, maxHeight: Math.max(0, Math.min(cap, above)) };
  return { below: true, maxHeight: Math.max(0, Math.min(cap, below)) };
}
