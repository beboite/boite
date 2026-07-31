import type { LayoutNode } from "./types";

export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/**
 * Where a pane goes before anything has measured it, or null when that cannot
 * be known yet.
 *
 * A group whose whole layout is one leaf covers the viewport: the shell root
 * fills it and the leaf is the root's only child, with nothing between them to
 * inset it (see the note on `.pane-shell-root` in PaneShell). So the answer is
 * known ahead of the measurement and is the same rect the measurement reports.
 * Waiting for it anyway meant a new thread could not mount until a
 * ResizeObserver had fired.
 *
 * Only for a group the user is looking at. A hidden group is laid out too, so
 * synthesising for one would mount its terminals and start their processes
 * before anything of them was ever on screen — N background groups, N agents
 * launched. A hidden pane waits for its measurement, which is one frame after
 * it is shown and costs nobody anything.
 *
 * The root being a leaf, rather than a count of one: the rect assumes the leaf
 * *is* the root's child, and a count cannot say that.
 */
export function unmeasuredRect(
  root: LayoutNode,
  viewport: Viewport | null,
  visible: boolean,
): PaneRect | null {
  if (!visible || !viewport) return null;
  if (root.kind !== "leaf") return null;
  return { x: 0, y: 0, w: viewport.w, h: viewport.h };
}

export function sameRect(a: PaneRect, b: PaneRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
