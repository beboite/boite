import type { InfoBoxAnchor } from "$lib/types";

export const INFO_BOX_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "mid-left",
  "mid-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const satisfies readonly InfoBoxAnchor[];

/** Gutter from the pane edge, in rem. Matches the 0.75rem the toaster uses. */
export const INFO_BOX_GUTTER_REM = 0.75;

export function isInfoBoxAnchor(value: unknown): value is InfoBoxAnchor {
  return (
    typeof value === "string" &&
    (INFO_BOX_ANCHORS as readonly string[]).includes(value)
  );
}

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, n));
}

/** Top-left of the box inside the pane, snapped to `anchor`. */
export function snapPoint(pane: Size, box: Size, gutter: number, anchor: InfoBoxAnchor): Point {
  const maxX = Math.max(gutter, pane.w - box.w - gutter);
  const maxY = Math.max(gutter, pane.h - box.h - gutter);
  const cx = clamp((pane.w - box.w) / 2, gutter, maxX);
  const cy = clamp((pane.h - box.h) / 2, gutter, maxY);
  switch (anchor) {
    case "top-left":
      return { x: gutter, y: gutter };
    case "top-center":
      return { x: cx, y: gutter };
    case "top-right":
      return { x: maxX, y: gutter };
    case "mid-left":
      return { x: gutter, y: cy };
    case "mid-right":
      return { x: maxX, y: cy };
    case "bottom-left":
      return { x: gutter, y: maxY };
    case "bottom-center":
      return { x: cx, y: maxY };
    case "bottom-right":
      return { x: maxX, y: maxY };
  }
}

/**
 * Dock for a bare point in the pane, by thirds rather than by distance.
 *
 * Measuring box centre against dock centre, which is what this replaced, makes
 * a wide box in a narrow pane pack its three columns within a few dozen pixels,
 * so the drag has to be aimed. This reads the pointer: the pane is a 3x3 grid, drop
 * anywhere in a third and that third wins. The middle cell has no dock, so it
 * resolves on the dominant axis away from the pane centre, and a release on the
 * exact centre keeps `fallback` rather than jumping somewhere arbitrary.
 */
export function anchorForPoint(
  pane: Size,
  x: number,
  y: number,
  fallback: InfoBoxAnchor,
): InfoBoxAnchor {
  if (pane.w <= 0 || pane.h <= 0) return fallback;
  const ux = clamp(x / pane.w, 0, 1);
  const uy = clamp(y / pane.h, 0, 1);
  const col = ux < 1 / 3 ? "left" : ux > 2 / 3 ? "right" : "center";
  const row = uy < 1 / 3 ? "top" : uy > 2 / 3 ? "bottom" : "mid";
  if (row !== "mid") return `${row}-${col}` as InfoBoxAnchor;
  if (col !== "center") return `mid-${col}` as InfoBoxAnchor;
  const offX = ux - 0.5;
  const offY = uy - 0.5;
  if (offX === 0 && offY === 0) return fallback;
  if (Math.abs(offX) >= Math.abs(offY)) return offX < 0 ? "mid-left" : "mid-right";
  return offY < 0 ? "top-center" : "bottom-center";
}

/** Keep a free-floating top-left inside the pane, gutter included. */
export function clampToPane(pane: Size, box: Size, gutter: number, x: number, y: number): Point {
  const maxX = Math.max(gutter, pane.w - box.w - gutter);
  const maxY = Math.max(gutter, pane.h - box.h - gutter);
  return { x: clamp(x, gutter, maxX), y: clamp(y, gutter, maxY) };
}
