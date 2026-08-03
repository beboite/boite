import { describe, expect, it } from "vitest";
import {
  clampRightPanelWidth,
  readRightPanelMap,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
} from "./right-panel";

describe("clampRightPanelWidth", () => {
  it("leaves a width the window can spare alone", () => {
    expect(clampRightPanelWidth(320, 1600)).toBe(320);
  });

  it("cuts a width dragged out on a wider monitor down to a share of this one", () => {
    // 600px was a third of the screen it was chosen on and is most of this one.
    expect(clampRightPanelWidth(600, 1000)).toBe(400);
  });

  it("never goes under the floor, however narrow the window", () => {
    // A window this small has no room for the column at all, and the answer to
    // that is to close it, not to draw a 120px git panel nobody can read.
    expect(clampRightPanelWidth(600, 400)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(50, 1600)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it("keeps the absolute ceiling on a very wide screen", () => {
    expect(clampRightPanelWidth(5000, 6000)).toBe(RIGHT_PANEL_MAX_WIDTH);
  });

  it("rounds, because a fractional pixel width paints a blurred border", () => {
    expect(clampRightPanelWidth(320.6, 1600)).toBe(321);
  });
});

describe("readRightPanelMap", () => {
  it("keeps the three panels and an explicit closed", () => {
    expect(
      readRightPanelMap({ a: "git", b: "explorer", c: "todo", d: null }),
    ).toEqual({ a: "git", b: "explorer", c: "todo", d: null });
  });

  it("drops what it cannot read rather than opening the column on nothing", () => {
    // A panel kind this build no longer has would otherwise reach SidePanel,
    // match no branch, and leave a bordered empty column beside the terminal.
    expect(readRightPanelMap({ a: "chat", b: 3, c: "git" })).toEqual({ c: "git" });
  });

  it("treats a missing or non-object blob as no memory at all", () => {
    expect(readRightPanelMap(undefined)).toEqual({});
    expect(readRightPanelMap("git")).toEqual({});
  });
});
