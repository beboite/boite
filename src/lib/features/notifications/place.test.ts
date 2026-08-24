import { describe, expect, it } from "vitest";
import { toastPlace, TOAST_WIDTH, type PlaceClaim } from "./place";

/**
 * The stack follows the info box. It must never be pinned from opposite
 * edges: that is what stretched it across the pane on a dock change.
 */

const vw = 1000;
const gap = 12;
const air = 8;
const area = { top: 40, right: 20 };

function claim(
  top: number,
  left: number,
  width: number,
  height: number,
  stack: PlaceClaim["stack"],
  align: PlaceClaim["align"],
): PlaceClaim {
  return {
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    stack,
    align,
  };
}

function place(next: PlaceClaim | null) {
  return toastPlace({ claim: next, area, vw, gap, air });
}

describe("where the toast stack sits", () => {
  it("falls back to the window corner when the work area is gone", () => {
    expect(toastPlace({ claim: null, area: null, vw, gap, air })).toEqual({
      top: null,
      left: null,
      above: false,
    });
  });

  it("sits in the work-area top-right when no box is standing", () => {
    expect(place(null)).toEqual({
      top: area.top + gap,
      left: vw - area.right - gap - TOAST_WIDTH,
      above: false,
    });
  });

  it("sits below a top-right box, right-aligned with it", () => {
    const box = claim(52, 648, TOAST_WIDTH, 84, "below", "right");
    expect(place(box)).toEqual({
      top: box.bottom + air,
      left: box.right - TOAST_WIDTH,
      above: false,
    });
  });

  it("sits below a top-left box, left-aligned with it", () => {
    const box = claim(52, 40, TOAST_WIDTH, 84, "below", "left");
    expect(place(box)).toEqual({
      top: box.bottom + air,
      left: box.left,
      above: false,
    });
  });

  it("sits below a top-center box, centered on it", () => {
    const box = claim(52, 200, 400, 84, "below", "center");
    expect(place(box)).toEqual({
      top: box.bottom + air,
      left: 200 + 400 / 2 - TOAST_WIDTH / 2,
      above: false,
    });
  });

  it("sits above a bottom-right box, still as top+left", () => {
    const box = claim(500, 648, TOAST_WIDTH, 84, "above", "right");
    expect(place(box)).toEqual({
      top: box.top - air,
      left: box.right - TOAST_WIDTH,
      above: true,
    });
  });

  it("sits above a bottom-left box", () => {
    const box = claim(500, 40, TOAST_WIDTH, 84, "above", "left");
    expect(place(box)).toEqual({
      top: box.top - air,
      left: box.left,
      above: true,
    });
  });

  it("follows a mid-left box below it", () => {
    const box = claim(300, 40, TOAST_WIDTH, 84, "below", "left");
    expect(place(box)).toEqual({
      top: box.bottom + air,
      left: box.left,
      above: false,
    });
  });

  it("never pins from the bottom or the right, on any dock", () => {
    const docks: PlaceClaim[] = [
      claim(52, 40, TOAST_WIDTH, 84, "below", "left"),
      claim(52, 340, TOAST_WIDTH, 84, "below", "center"),
      claim(52, 648, TOAST_WIDTH, 84, "below", "right"),
      claim(300, 40, TOAST_WIDTH, 84, "below", "left"),
      claim(300, 648, TOAST_WIDTH, 84, "below", "right"),
      claim(500, 40, TOAST_WIDTH, 84, "above", "left"),
      claim(500, 340, TOAST_WIDTH, 84, "above", "center"),
      claim(500, 648, TOAST_WIDTH, 84, "above", "right"),
    ];
    for (const box of docks) {
      const next = place(box);
      expect(next).not.toHaveProperty("right");
      expect(next).not.toHaveProperty("bottom");
      expect(next.top).not.toBeNull();
      expect(next.left).not.toBeNull();
    }
  });

  it("keeps the stack on screen when a right-aligned box is in a narrow pane", () => {
    const box = claim(52, 700, TOAST_WIDTH, 84, "below", "right");
    const next = toastPlace({ claim: box, area, vw: 800, gap, air });
    expect(next.left).toBe(800 - TOAST_WIDTH - gap);
  });
});
