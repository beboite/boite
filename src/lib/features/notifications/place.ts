/**
 * Where the toast stack sits, always the work-area top-right.
 *
 * The info box can dock on any of eight edges. Following it meant the stack
 * jumped left, centre, below, above, and flipped its flex direction on a drop.
 * Approvals own the bottom centre and the connection banner owns the top, so a
 * stack that tracked the box landed on both. The only move that is still
 * allowed is down, and only when the box is already occupying that corner.
 */

export type ToastBox = {
  top: number | null;
  right: number | null;
  bottom: number | null;
  left: number | null;
};

export type ToastArea = { top: number; right: number };

export type ToastRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export const TOAST_WIDTH = 320;
export const TOAST_GAP_REM = 0.75;
export const TOAST_AIR_REM = 0.5;
/** How much of the top-right corner counts as occupied. About two cards. */
export const TOAST_SLOT_HEIGHT = 160;

export type PlaceInput = {
  claim: ToastRect | null;
  area: ToastArea | null;
  vw: number;
  gap: number;
  air: number;
  width?: number;
  slotHeight?: number;
};

function overlaps(a: ToastRect, b: ToastRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function toastPlace(input: PlaceInput): ToastBox {
  const empty: ToastBox = { top: null, right: null, bottom: null, left: null };
  const { claim, area, vw, gap, air } = input;
  if (!area) return empty;

  const width = input.width ?? TOAST_WIDTH;
  const slotHeight = input.slotHeight ?? TOAST_SLOT_HEIGHT;
  const top = area.top + gap;
  const right = area.right + gap;
  const corner: ToastBox = { top, right, bottom: null, left: null };
  if (!claim) return corner;

  const slot: ToastRect = {
    top,
    right: vw - right,
    left: vw - right - width,
    bottom: top + slotHeight,
  };
  if (!overlaps(claim, slot)) return corner;
  return { top: claim.bottom + air, right, bottom: null, left: null };
}
