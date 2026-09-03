/**
 * Where a context menu's top edge goes.
 *
 * Pulled out of the component because it is arithmetic with four edge cases and
 * the component needs a DOM to exist at all.
 */

/** A band of the viewport the menu must stay off, in client coordinates. */
export interface AvoidBand {
  top: number;
  bottom: number;
}

/**
 * The menu is anchored to the pointer and offset off the row it was called on.
 *
 * A menu drawn at the pointer covers the row under the pointer, which is the
 * row the menu is about: the thread menu hid its own thread's name, so the only
 * way to check which thread was about to be closed was to close the menu. Below
 * the band when there is room for the whole menu, above it otherwise.
 *
 * With room on neither side the plain clamp comes back and the menu covers the
 * row again. That is a menu taller than half the window, and running it off the
 * screen edge to keep one row visible would cost more than it saves.
 */
export function menuTop(
  y: number,
  height: number,
  viewportHeight: number,
  gap: number,
  avoid: AvoidBand | null,
): number {
  const clamp = (v: number) =>
    Math.max(gap, Math.min(v, viewportHeight - height - gap));
  if (!avoid) return clamp(y);
  const below = avoid.bottom + gap;
  if (below + height <= viewportHeight - gap) return below;
  const above = avoid.top - gap - height;
  if (above >= gap) return above;
  return clamp(y);
}
