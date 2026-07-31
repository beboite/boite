import { describe, expect, it } from "vitest";

import { sameRect, unmeasuredRect } from "./rect";
import { threadPane, type LayoutNode } from "./types";

const leaf: LayoutNode = threadPane("t1");
const split: LayoutNode = {
  kind: "split",
  id: "s1",
  dir: "row",
  ratios: [0.5, 0.5],
  children: [leaf, threadPane("t2")],
};
const viewport = { w: 1200, h: 800 };

describe("unmeasuredRect", () => {
  it("gives a lone visible leaf the whole viewport before anything is measured", () => {
    expect(unmeasuredRect(leaf, viewport, true)).toEqual({
      x: 0,
      y: 0,
      w: 1200,
      h: 800,
    });
  });

  // The one that matters: a hidden group is still laid out, so answering for it
  // mounts its terminals and starts their processes before they have ever been
  // on screen. Twenty background groups meant twenty agents launched.
  it("says nothing about a group nobody is looking at", () => {
    expect(unmeasuredRect(leaf, viewport, false)).toBeNull();
  });

  it("says nothing about a split, whose leaves it cannot place", () => {
    expect(unmeasuredRect(split, viewport, true)).toBeNull();
  });

  it("says nothing before the viewport itself has been measured", () => {
    expect(unmeasuredRect(leaf, null, true)).toBeNull();
  });
});

describe("sameRect", () => {
  it("is true only when every side agrees", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(sameRect(a, { ...a })).toBe(true);
    expect(sameRect(a, { ...a, w: 11 })).toBe(false);
    expect(sameRect(a, { ...a, x: 1 })).toBe(false);
  });
});
