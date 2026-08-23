/**
 * Where the toast stack sits: glued to the standing info box.
 *
 * The first version pinned the toaster with `top` or `bottom`, `left` or
 * `right`, whichever edge the dock used. Switching a `position: fixed` box
 * from `top` to `bottom` (or `right` to `left`) leaves both edges set for a
 * frame, so the stack stretches across the pane. That is the "going in every
 * direction" bug. Always `top` + `left`; stacking above is `translateY(-100%)`.
 */

export type ToastStack = "above" | "below";
export type ToastAlign = "left" | "center" | "right";

export type ToastPlace = {
  top: number | null;
  left: number | null;
  above: boolean;
};

export type ToastArea = { top: number; right: number };

export type PlaceClaim = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  stack: ToastStack;
  align: ToastAlign;
};

export const TOAST_WIDTH = 320;
export const TOAST_GAP_REM = 0.75;
export const TOAST_AIR_REM = 0.5;

export type PlaceInput = {
  claim: PlaceClaim | null;
  area: ToastArea | null;
  vw: number;
  gap: number;
  air: number;
  width?: number;
};

export function toastPlace(input: PlaceInput): ToastPlace {
  const empty: ToastPlace = { top: null, left: null, above: false };
  const { claim, area, vw, gap, air } = input;
  const width = input.width ?? TOAST_WIDTH;

  if (claim) {
    const above = claim.stack === "above";
    const top = above ? claim.top - air : claim.bottom + air;
    let left =
      claim.align === "left"
        ? claim.left
        : claim.align === "right"
          ? claim.right - width
          : claim.left + claim.width / 2 - width / 2;
    left = Math.max(gap, Math.min(left, vw - width - gap));
    return { top, left, above };
  }

  if (area) {
    return {
      top: area.top + gap,
      left: vw - area.right - gap - width,
      above: false,
    };
  }

  return empty;
}
