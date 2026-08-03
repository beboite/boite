import { describe, expect, it } from "vitest";
import { Touches } from "./touch";

/** One finger at a height. */
const at = (...ys: number[]) => ys.map((y) => ({ clientX: 0, clientY: y }));
/** Two fingers `apart` pixels apart, on one column so the distance is exact. */
const pinch = (apart: number) => [
  { clientX: 0, clientY: 0 },
  { clientX: 0, clientY: apart },
];
const ROW = 20;

describe("dragging to scroll", () => {
  it("scrolls the opposite way to the finger", () => {
    const touches = new Touches();
    touches.start(at(300), 1);
    // Dragging down by a row reveals older output.
    expect(touches.move(at(320), ROW)).toEqual({ kind: "scroll", lines: -1 });
    expect(touches.move(at(300), ROW)).toEqual({ kind: "scroll", lines: 1 });
  });

  /// The reason the leftover is kept: a slow drag is many moves of a few
  /// pixels, and dropping the remainder each time means it never scrolls at
  /// all.
  it("adds up movement smaller than a row", () => {
    const touches = new Touches();
    touches.start(at(300), 1);
    for (const y of [305, 310, 315]) {
      expect(touches.move(at(y), ROW)).toEqual({ kind: "none" });
    }
    expect(touches.move(at(320), ROW)).toEqual({ kind: "scroll", lines: -1 });
  });

  /// And the other half of the same rule: what is left over after a whole row
  /// stays, so ten drags of eleven pixels move five rows rather than ten.
  it("keeps the remainder rather than rounding it away", () => {
    const touches = new Touches();
    touches.start(at(0), 1);
    let moved = 0;
    for (let i = 1; i <= 10; i++) {
      const g = touches.move(at(i * 11), ROW);
      if (g.kind === "scroll") moved += -g.lines;
    }
    expect(moved).toBe(5);
  });

  it("reports a fast drag as many lines at once", () => {
    const touches = new Touches();
    touches.start(at(0), 1);
    expect(touches.move(at(200), ROW)).toEqual({ kind: "scroll", lines: -10 });
  });
});

describe("pinching to size the font", () => {
  it("answers the ratio of the two distances", () => {
    const touches = new Touches();
    touches.start(pinch(100), 1);
    expect(touches.mode).toBe("pinch");
    expect(touches.move(pinch(200), ROW)).toEqual({ kind: "zoom", factor: 2 });
    // Relative to where the pinch started, not to the last move.
    expect(touches.move(pinch(50), ROW)).toEqual({ kind: "zoom", factor: 0.5 });
  });

  it("starts from the factor the caller was already at", () => {
    const touches = new Touches();
    touches.start(pinch(100), 1.5);
    expect(touches.move(pinch(200), ROW)).toEqual({ kind: "zoom", factor: 3 });
  });

  /// Two fingers landing at the same point is a division by zero, and a
  /// terminal whose font size becomes NaN does not come back.
  it("says nothing when the two fingers started together", () => {
    const touches = new Touches();
    touches.start(pinch(0), 1);
    expect(touches.move(pinch(100), ROW)).toEqual({ kind: "none" });
  });
});

describe("letting go", () => {
  /// The remaining finger is still on the screen. Treating it as a fresh touch
  /// is what makes the terminal jump when a pinch ends unevenly.
  it("hands a released pinch back to scrolling from where the finger is", () => {
    const touches = new Touches();
    touches.start(pinch(100), 1);
    touches.end(at(400));
    expect(touches.mode).toBe("scroll");
    // No jump: the first move after the release is measured from 400.
    expect(touches.move(at(405), ROW)).toEqual({ kind: "none" });
    expect(touches.move(at(420), ROW)).toEqual({ kind: "scroll", lines: -1 });
  });

  it("ends when the last finger leaves", () => {
    const touches = new Touches();
    touches.start(at(300), 1);
    touches.end([]);
    expect(touches.mode).toBe("none");
    expect(touches.move(at(400), ROW)).toEqual({ kind: "none" });
  });
});
