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

/** Toasts sit under the box, except on the bottom edge where they stack up. */
export function toastStackFor(anchor: InfoBoxAnchor): "above" | "below" {
  return anchor.startsWith("bottom") ? "above" : "below";
}

export function toastAlignFor(anchor: InfoBoxAnchor): "left" | "center" | "right" {
  if (anchor.endsWith("left")) return "left";
  if (anchor.endsWith("right")) return "right";
  return "center";
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

/** Nearest of the eight docks to a free-floating top-left. */
export function nearestAnchor(
  pane: Size,
  box: Size,
  gutter: number,
  x: number,
  y: number,
): InfoBoxAnchor {
  const cx = x + box.w / 2;
  const cy = y + box.h / 2;
  let best: InfoBoxAnchor = "top-right";
  let bestD = Number.POSITIVE_INFINITY;
  for (const anchor of INFO_BOX_ANCHORS) {
    const p = snapPoint(pane, box, gutter, anchor);
    const dx = cx - (p.x + box.w / 2);
    const dy = cy - (p.y + box.h / 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = anchor;
    }
  }
  return best;
}

/** Keep a free-floating top-left inside the pane, gutter included. */
export function clampToPane(pane: Size, box: Size, gutter: number, x: number, y: number): Point {
  const maxX = Math.max(gutter, pane.w - box.w - gutter);
  const maxY = Math.max(gutter, pane.h - box.h - gutter);
  return { x: clamp(x, gutter, maxX), y: clamp(y, gutter, maxY) };
}
