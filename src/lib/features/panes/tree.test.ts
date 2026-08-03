import { describe, expect, it } from "vitest";
import {
  countLeaves,
  findContent,
  injectSibling,
  leavesOf,
  normalize,
  pruneLeaf,
  threadLeavesOf,
  findSplit,
} from "./tree";
import { sameContent, threadPane, threadIdOf } from "./types";
import type { LayoutNode } from "./types";

let counter = 0;
const nextId = () => `s${++counter}`;

function panel(paneId: string, kind: "git" | "todo" | "dashboard"): LayoutNode {
  return { kind: "leaf", paneId, content: { kind } };
}

function splitOf(node: LayoutNode): Extract<LayoutNode, { kind: "split" }> {
  if (node.kind !== "split") throw new Error("expected a split");
  return node;
}

describe("leaves", () => {
  it("reads pane ids in layout order", () => {
    const tree = injectSibling(
      threadPane("a"),
      "a",
      threadPane("b"),
      "row",
      false,
      0.5,
      nextId,
    )!;
    expect(leavesOf(tree)).toEqual(["a", "b"]);
    expect(countLeaves(tree)).toBe(2);
  });

  it("separates threads from panels", () => {
    const tree = injectSibling(
      threadPane("a"),
      "a",
      panel("p1", "git"),
      "row",
      false,
      0.35,
      nextId,
    )!;
    expect(leavesOf(tree)).toEqual(["a", "p1"]);
    // The distinction the status engine and Ctrl+Tab depend on: a git panel is
    // a pane, not a terminal, and looking it up as a thread finds nothing.
    expect(threadLeavesOf(tree)).toEqual(["a"]);
  });

  it("keeps a thread pane named by its thread", () => {
    const leaf = threadPane("t1");
    if (leaf.kind !== "leaf") throw new Error("threadPane must build a leaf");
    expect(leaf.paneId).toBe("t1");
    expect(threadIdOf(leaf.content)).toBe("t1");
    expect(threadIdOf({ kind: "git" })).toBeNull();
  });
});

describe("injectSibling", () => {
  it("gives the newcomer its share and leaves the target the rest", () => {
    const tree = splitOf(
      injectSibling(
        threadPane("a"),
        "a",
        panel("p1", "git"),
        "row",
        false,
        0.3,
        nextId,
      )!,
    );
    expect(tree.dir).toBe("row");
    expect(tree.ratios).toEqual([0.7, 0.3]);
    expect(leavesOf(tree)).toEqual(["a", "p1"]);
  });

  it("puts it first when the drop was on the leading edge", () => {
    const tree = splitOf(
      injectSibling(
        threadPane("a"),
        "a",
        panel("p1", "git"),
        "row",
        true,
        0.25,
        nextId,
      )!,
    );
    expect(leavesOf(tree)).toEqual(["p1", "a"]);
    expect(tree.ratios).toEqual([0.25, 0.75]);
  });

  it("only takes room from the cell it was dropped on", () => {
    // Three equal columns; a panel opens beside the middle one at 40%. The
    // outer two must not move: resizing a sibling nobody touched is the bug
    // this ratio arithmetic exists to avoid.
    let tree = injectSibling(
      threadPane("a"),
      "a",
      threadPane("b"),
      "row",
      false,
      0.5,
      nextId,
    )!;
    tree = injectSibling(tree, "b", threadPane("c"), "row", false, 0.5, nextId)!;
    const before = splitOf(tree).ratios.slice();
    expect(before.map((r) => Math.round(r * 100))).toEqual([50, 25, 25]);

    const after = splitOf(
      injectSibling(tree, "b", panel("p1", "git"), "row", false, 0.4, nextId)!,
    );
    expect(leavesOf(after)).toEqual(["a", "b", "p1", "c"]);
    expect(after.ratios[0]).toBeCloseTo(before[0]);
    expect(after.ratios[3]).toBeCloseTo(before[2]);
    expect(after.ratios[1] + after.ratios[2]).toBeCloseTo(before[1]);
    expect(after.ratios[2] / before[1]).toBeCloseTo(0.4);
  });

  it("nests when the new direction crosses the existing one", () => {
    let tree = injectSibling(
      threadPane("a"),
      "a",
      threadPane("b"),
      "row",
      false,
      0.5,
      nextId,
    )!;
    tree = injectSibling(tree, "b", panel("p1", "todo"), "column", false, 0.5, nextId)!;
    const root = splitOf(tree);
    expect(root.dir).toBe("row");
    expect(root.children[1].kind).toBe("split");
    expect(splitOf(root.children[1]).dir).toBe("column");
    expect(leavesOf(tree)).toEqual(["a", "b", "p1"]);
  });

  it("reports a miss instead of guessing", () => {
    expect(
      injectSibling(threadPane("a"), "nope", threadPane("b"), "row", false, 0.5, nextId),
    ).toBeNull();
  });
});

describe("pruneLeaf", () => {
  it("collapses a split left with one child", () => {
    // Otherwise the tree accumulates single-child splits, each one a splitter
    // handle the user can grab that moves nothing.
    const tree = injectSibling(
      threadPane("a"),
      "a",
      threadPane("b"),
      "row",
      false,
      0.5,
      nextId,
    )!;
    const pruned = pruneLeaf(tree, "b")!;
    expect(pruned.kind).toBe("leaf");
    expect(leavesOf(pruned)).toEqual(["a"]);
  });

  it("renormalises what is left", () => {
    let tree = injectSibling(
      threadPane("a"),
      "a",
      threadPane("b"),
      "row",
      false,
      0.5,
      nextId,
    )!;
    tree = injectSibling(tree, "b", threadPane("c"), "row", false, 0.5, nextId)!;
    const pruned = splitOf(pruneLeaf(tree, "a")!);
    expect(pruned.ratios.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    expect(leavesOf(pruned)).toEqual(["b", "c"]);
  });

  it("returns null when the last leaf goes", () => {
    expect(pruneLeaf(threadPane("a"), "a")).toBeNull();
  });

  it("leaves the tree alone when the id is not in it", () => {
    const tree = threadPane("a");
    expect(pruneLeaf(tree, "zzz")).toBe(tree);
  });
});

describe("findContent", () => {
  it("finds the pane already showing this thing", () => {
    // What stops a second call from opening a second git panel, which is how
    // four MCP calls in a row would otherwise fill the group and hit the cap.
    const tree = injectSibling(
      threadPane("a"),
      "a",
      panel("p1", "git"),
      "row",
      false,
      0.35,
      nextId,
    )!;
    const hit = findContent(tree, (c) => sameContent(c, { kind: "git" }));
    expect(hit?.paneId).toBe("p1");
    expect(findContent(tree, (c) => sameContent(c, { kind: "todo" }))).toBeNull();
  });

  it("tells two browser panes apart by their address", () => {
    const a = { kind: "browser", url: "http://localhost:5173" } as const;
    const b = { kind: "browser", url: "http://localhost:3000" } as const;
    expect(sameContent(a, a)).toBe(true);
    expect(sameContent(a, b)).toBe(false);
  });
});

describe("ratios", () => {
  it("normalises to one", () => {
    expect(normalize([1, 3]).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // A degenerate set splits evenly rather than dividing by zero and painting
    // every pane at NaN width.
    expect(normalize([0, 0])).toEqual([0.5, 0.5]);
  });

  it("writes only the split it was given", () => {
    let tree = injectSibling(
      threadPane("a"),
      "a",
      threadPane("b"),
      "row",
      false,
      0.5,
      nextId,
    )!;
    const outerId = splitOf(tree).id;
    tree = injectSibling(tree, "b", threadPane("c"), "column", false, 0.5, nextId)!;
    const innerId = splitOf(splitOf(tree).children[1]).id;

    // Found rather than rebuilt, and mutated in place. A splitter drag calls
    // this at pointer rate, and replacing the tree from the root down made the
    // store's leaf indexes recompute on every move even though no pane had
    // appeared, moved or gone.
    const split = findSplit(tree, innerId)!;
    expect(split).toBe(splitOf(splitOf(tree).children[1]));
    split.ratios = [0.8, 0.2];
    expect(splitOf(splitOf(tree).children[1]).ratios).toEqual([0.8, 0.2]);
    expect(splitOf(tree).id).toBe(outerId);
    // And a splitter that is not in this tree is not found.
    expect(findSplit(tree, "no-such-split")).toBe(null);
  });
});
