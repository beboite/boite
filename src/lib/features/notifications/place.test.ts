import { describe, expect, it } from "vitest";
import { toastPlace, TOAST_SLOT_HEIGHT, TOAST_WIDTH } from "./place";

/**
 * The stack stays in the work-area top-right. Following the info box around
 * the eight docks was what put cards over the approval dock, over the
 * connection banner, and in the middle of a terminal.
 */

const vw = 1000;
const gap = 12;
const air = 8;
const area = { top: 40, right: 20 };

function place(
  claim: { top: number; left: number; right: number; bottom: number } | null,
) {
  return toastPlace({ claim, area, vw, gap, air });
}

function rect(top: number, left: number, width: number, height: number) {
  return { top, left, right: left + width, bottom: top + height };
}

describe("where the toast stack sits", () => {
  it("falls back to the window corner when the work area is gone", () => {
    expect(toastPlace({ claim: null, area: null, vw, gap, air })).toEqual({
      top: null,
      right: null,
      bottom: null,
      left: null,
    });
  });

  it("sits in the work-area top-right when no box is standing", () => {
    expect(place(null)).toEqual({
      top: area.top + gap,
      right: area.right + gap,
      bottom: null,
      left: null,
    });
  });

  it("drops below a box that occupies that same corner", () => {
    const box = rect(52, 648, TOAST_WIDTH, 84);
    expect(place(box)).toEqual({
      top: box.bottom + air,
      right: area.right + gap,
      bottom: null,
      left: null,
    });
  });

  it("does not follow a box docked on the left", () => {
    expect(place(rect(52, 40, TOAST_WIDTH, 84))).toEqual(place(null));
  });

  it("does not follow a box docked on the bottom-right", () => {
    expect(place(rect(500, 648, TOAST_WIDTH, 84))).toEqual(place(null));
  });

  it("does not follow a box at mid-right", () => {
    expect(place(rect(300, 648, TOAST_WIDTH, 84))).toEqual(place(null));
  });

  it("never returns left or bottom, which is how the stack used to fly", () => {
    const boxes = [
      rect(52, 40, TOAST_WIDTH, 84),
      rect(52, 340, TOAST_WIDTH, 84),
      rect(52, 648, TOAST_WIDTH, 84),
      rect(500, 40, TOAST_WIDTH, 84),
      rect(500, 648, TOAST_WIDTH, 84),
    ];
    for (const box of boxes) {
      const next = place(box);
      expect(next.left).toBeNull();
      expect(next.bottom).toBeNull();
    }
  });

  it("drops on a top-center box that clips the slot, still right-aligned", () => {
    // 800px work area, box centred: 240-560. Toast slot starts at 468, so they
    // overlap on the right third of the box. Drop, do not slide to centre.
    const box = rect(52, 240, TOAST_WIDTH, 84);
    const next = toastPlace({
      claim: box,
      area: { top: 40, right: 0 },
      vw: 800,
      gap,
      air,
    });
    expect(next.top).toBe(box.bottom + air);
    expect(next.right).toBe(gap);
    expect(next.left).toBeNull();
  });

  it("uses the slot height, not the box height, to decide occupancy", () => {
    // A short box at the top of the slot still occupies the corner.
    const short = rect(52, 648, TOAST_WIDTH, 40);
    expect(short.bottom).toBeLessThan(52 + TOAST_SLOT_HEIGHT);
    expect(place(short).top).toBe(short.bottom + air);
  });
});
