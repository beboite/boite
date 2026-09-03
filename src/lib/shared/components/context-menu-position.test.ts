import { describe, expect, it } from "vitest";
import { menuTop } from "./context-menu-position";

const GAP = 4;
const VH = 800;

describe("placing a context menu off the row it belongs to", () => {
  it("keeps the pointer's y when there is nothing to avoid", () => {
    expect(menuTop(300, 200, VH, GAP, null)).toBe(300);
  });

  it("clamps to the viewport when there is nothing to avoid", () => {
    expect(menuTop(700, 200, VH, GAP, null)).toBe(VH - 200 - GAP);
    expect(menuTop(-50, 200, VH, GAP, null)).toBe(GAP);
  });

  /**
   * The finding this exists for: the menu opened at the pointer, which is on
   * the row, so the row's own name was the first thing it covered.
   */
  it("drops below the row when there is room", () => {
    const top = menuTop(210, 200, VH, GAP, { top: 200, bottom: 224 });
    expect(top).toBe(228);
    expect(top).toBeGreaterThanOrEqual(224);
  });

  it("goes above the row when there is no room below", () => {
    const top = menuTop(700, 200, VH, GAP, { top: 690, bottom: 714 });
    expect(top).toBe(690 - GAP - 200);
    expect(top + 200).toBeLessThanOrEqual(690);
  });

  it("fits a menu that only just clears the row", () => {
    // bottom 500, gap 4, height 292 lands exactly on the 796 the clamp allows.
    expect(menuTop(490, 292, VH, GAP, { top: 476, bottom: 500 })).toBe(504);
  });

  it("falls back to the clamp when neither side fits", () => {
    const top = menuTop(400, 700, VH, GAP, { top: 390, bottom: 414 });
    expect(top).toBe(VH - 700 - GAP);
  });
});
