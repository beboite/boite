import { describe, expect, it } from "vitest";
import { anchorForPoint, clampToPane, isInfoBoxAnchor, snapPoint } from "./anchor";

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

  it("picks the dock from the third the pointer was released in", () => {
    expect(anchorForPoint(pane, 40, 40, "top-right")).toBe("top-left");
    expect(anchorForPoint(pane, 400, 40, "top-right")).toBe("top-center");
    expect(anchorForPoint(pane, 760, 40, "top-left")).toBe("top-right");
    expect(anchorForPoint(pane, 40, 300, "top-right")).toBe("mid-left");
    expect(anchorForPoint(pane, 760, 300, "top-right")).toBe("mid-right");
    expect(anchorForPoint(pane, 40, 560, "top-right")).toBe("bottom-left");
    expect(anchorForPoint(pane, 400, 560, "top-right")).toBe("bottom-center");
    expect(anchorForPoint(pane, 760, 560, "top-right")).toBe("bottom-right");
  });

  it("resolves the middle cell on the dominant axis, and holds on the exact centre", () => {
    expect(anchorForPoint(pane, 330, 300, "top-right")).toBe("mid-left");
    expect(anchorForPoint(pane, 470, 300, "top-right")).toBe("mid-right");
    expect(anchorForPoint(pane, 400, 210, "top-right")).toBe("top-center");
    expect(anchorForPoint(pane, 400, 390, "top-right")).toBe("bottom-center");
    expect(anchorForPoint(pane, 400, 300, "mid-left")).toBe("mid-left");
  });

  it("clamps a release outside the pane onto the matching corner", () => {
    expect(anchorForPoint(pane, -200, -200, "mid-left")).toBe("top-left");
    expect(anchorForPoint(pane, 2000, 2000, "mid-left")).toBe("bottom-right");
    expect(anchorForPoint({ w: 0, h: 0 }, 10, 10, "bottom-center")).toBe("bottom-center");
  });

  it("keeps a drag inside the pane", () => {
    expect(clampToPane(pane, box, gutter, -40, -10)).toEqual({ x: 12, y: 12 });
    expect(clampToPane(pane, box, gutter, 900, 900)).toEqual({ x: 468, y: 508 });
  });
});
