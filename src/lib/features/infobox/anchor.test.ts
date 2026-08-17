import { describe, expect, it } from "vitest";
import {
  clampToPane,
  isInfoBoxAnchor,
  nearestAnchor,
  snapPoint,
  toastAlignFor,
  toastStackFor,
} from "./anchor";

const pane = { w: 800, h: 600 };
const box = { w: 320, h: 80 };
const gutter = 12;

describe("info box docks", () => {
  it("rejects anything that is not one of the eight", () => {
    expect(isInfoBoxAnchor("top-right")).toBe(true);
    expect(isInfoBoxAnchor("mid-left")).toBe(true);
    expect(isInfoBoxAnchor("bottom-center")).toBe(true);
    expect(isInfoBoxAnchor("center")).toBe(false);
    expect(isInfoBoxAnchor("")).toBe(false);
  });

  it("puts each dock against the matching edge", () => {
    expect(snapPoint(pane, box, gutter, "top-left")).toEqual({ x: 12, y: 12 });
    expect(snapPoint(pane, box, gutter, "top-right")).toEqual({ x: 468, y: 12 });
    expect(snapPoint(pane, box, gutter, "bottom-left")).toEqual({ x: 12, y: 508 });
    expect(snapPoint(pane, box, gutter, "bottom-right")).toEqual({ x: 468, y: 508 });
    expect(snapPoint(pane, box, gutter, "top-center")).toEqual({ x: 240, y: 12 });
    expect(snapPoint(pane, box, gutter, "bottom-center")).toEqual({ x: 240, y: 508 });
    expect(snapPoint(pane, box, gutter, "mid-left")).toEqual({ x: 12, y: 260 });
    expect(snapPoint(pane, box, gutter, "mid-right")).toEqual({ x: 468, y: 260 });
  });

  it("picks the nearest dock from a free-floating point", () => {
    expect(nearestAnchor(pane, box, gutter, 20, 20)).toBe("top-left");
    expect(nearestAnchor(pane, box, gutter, 450, 20)).toBe("top-right");
    expect(nearestAnchor(pane, box, gutter, 230, 20)).toBe("top-center");
    expect(nearestAnchor(pane, box, gutter, 20, 250)).toBe("mid-left");
    expect(nearestAnchor(pane, box, gutter, 450, 250)).toBe("mid-right");
    expect(nearestAnchor(pane, box, gutter, 20, 500)).toBe("bottom-left");
    expect(nearestAnchor(pane, box, gutter, 230, 500)).toBe("bottom-center");
    expect(nearestAnchor(pane, box, gutter, 450, 500)).toBe("bottom-right");
  });

  it("stacks toasts above only on the bottom edge", () => {
    expect(toastStackFor("top-right")).toBe("below");
    expect(toastStackFor("mid-left")).toBe("below");
    expect(toastStackFor("bottom-center")).toBe("above");
    expect(toastAlignFor("top-left")).toBe("left");
    expect(toastAlignFor("mid-right")).toBe("right");
    expect(toastAlignFor("bottom-center")).toBe("center");
  });

  it("keeps a drag inside the pane", () => {
    expect(clampToPane(pane, box, gutter, -40, -10)).toEqual({ x: 12, y: 12 });
    expect(clampToPane(pane, box, gutter, 900, 900)).toEqual({ x: 468, y: 508 });
  });
});
