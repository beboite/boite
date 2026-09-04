import { describe, expect, it } from "vitest";
import { atBottom, ESTIMATE, OVERSCAN, windowFor } from "./virtual";

const uniform = (count: number, height = 100) => Array.from({ length: count }, () => height);

describe("windowFor", () => {
  it("has nothing to draw for an empty list", () => {
    expect(windowFor([], 0, 500)).toEqual({ start: 0, end: 0, before: 0, after: 0, total: 0 });
  });

  // The point of the whole module: a two thousand item thread must not be two
  // thousand DOM nodes.
  it("draws a viewport's worth, not the list", () => {
    const win = windowFor(uniform(2000), 0, 600);
    expect(win.end - win.start).toBeLessThan(20);
    expect(win.total).toBe(200000);
  });

  it("keeps the spacers adding up to the whole list", () => {
    const heights = uniform(500);
    const win = windowFor(heights, 12000, 600);
    let drawn = 0;
    for (let i = win.start; i < win.end; i++) drawn += heights[i];
    expect(win.before + drawn + win.after).toBe(win.total);
  });

  it("keeps an overscan band on both sides", () => {
    const win = windowFor(uniform(500), 12000, 600);
    expect(win.start).toBe(120 - OVERSCAN);
  });

  it("counts an unmeasured row as the estimate", () => {
    const win = windowFor([0, 0, 0], 0, 500);
    expect(win.total).toBe(3 * ESTIMATE);
    expect(win.end).toBe(3);
  });

  it("answers with the tail when scrolled past the end", () => {
    const win = windowFor(uniform(10), 99999, 600);
    expect(win.end).toBe(10);
    expect(win.start).toBeLessThan(10);
  });
});

describe("atBottom", () => {
  it("counts a few pixels short as the end", () => {
    expect(atBottom(1000, 600, 1620)).toBe(true);
    expect(atBottom(1000, 600, 2000)).toBe(false);
  });
});
