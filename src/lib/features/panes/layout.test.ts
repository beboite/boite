import { describe, expect, it } from "vitest";
import { isPaneGroup } from "./layout";

// The saved layout lives in localStorage, which the user can edit and an older
// build may have written in another shape. Every one of these has to be dropped
// rather than handed to the renderer.
const leaf = (threadId: string) => ({
  kind: "leaf",
  paneId: threadId,
  content: { kind: "thread", threadId },
});

/** A pane that is not a terminal, so its id is its own. */
const panel = (paneId: string, content: unknown) => ({ kind: "leaf", paneId, content });

function group(root: unknown, focusedPaneId: string) {
  return { id: "g1", projectId: "p1", root, focusedPaneId };
}

describe("isPaneGroup", () => {
  it("accepts a single leaf", () => {
    expect(isPaneGroup(group(leaf("t1"), "t1"))).toBe(true);
  });

  it("accepts a nested split whose ratios match its children", () => {
    const root = {
      kind: "split",
      id: "s1",
      dir: "row",
      ratios: [0.5, 0.5],
      children: [
        leaf("t1"),
        {
          kind: "split",
          id: "s2",
          dir: "column",
          ratios: [0.3, 0.7],
          children: [leaf("t2"), leaf("t3")],
        },
      ],
    };
    expect(isPaneGroup(group(root, "t3"))).toBe(true);
  });

  it("rejects a focus that is not one of its own leaves", () => {
    expect(isPaneGroup(group(leaf("t1"), "t2"))).toBe(false);
  });

  it("rejects ratios that do not match the child count", () => {
    const root = {
      kind: "split",
      id: "s1",
      dir: "row",
      ratios: [1],
      children: [leaf("t1"), leaf("t2")],
    };
    expect(isPaneGroup(group(root, "t1"))).toBe(false);
  });

  it("rejects a zero or negative ratio, which would collapse a pane for good", () => {
    for (const ratios of [[0, 1], [-1, 2], [Number.NaN, 1]]) {
      const root = {
        kind: "split",
        id: "s1",
        dir: "row",
        ratios,
        children: [leaf("t1"), leaf("t2")],
      };
      expect(isPaneGroup(group(root, "t1"))).toBe(false);
    }
  });

  it("rejects a split with fewer than two children", () => {
    const root = {
      kind: "split",
      id: "s1",
      dir: "row",
      ratios: [1],
      children: [leaf("t1")],
    };
    expect(isPaneGroup(group(root, "t1"))).toBe(false);
  });

  it("rejects an unknown direction", () => {
    const root = {
      kind: "split",
      id: "s1",
      dir: "diagonal",
      ratios: [0.5, 0.5],
      children: [leaf("t1"), leaf("t2")],
    };
    expect(isPaneGroup(group(root, "t1"))).toBe(false);
  });

  it("rejects a tree deep enough to be a runaway", () => {
    let root: unknown = leaf("t1");
    for (let i = 0; i < 12; i++) {
      root = {
        kind: "split",
        id: `s${i}`,
        dir: "row",
        ratios: [0.5, 0.5],
        children: [root, leaf(`x${i}`)],
      };
    }
    expect(isPaneGroup(group(root, "t1"))).toBe(false);
  });

  it("rejects the shapes a hand-edited blob actually produces", () => {
    expect(isPaneGroup(null)).toBe(false);
    expect(isPaneGroup(undefined)).toBe(false);
    expect(isPaneGroup("g1")).toBe(false);
    expect(isPaneGroup([])).toBe(false);
    expect(isPaneGroup({})).toBe(false);
    expect(isPaneGroup(group({ kind: "leaf" }, "t1"))).toBe(false);
    expect(isPaneGroup(group({ kind: "tree", paneId: "t1" }, "t1"))).toBe(false);
    expect(isPaneGroup({ id: 1, projectId: "p1", root: leaf("t1"), focusedPaneId: "t1" })).toBe(
      false,
    );
    // The shape this validator was written against, which is now the old one.
    expect(isPaneGroup(group({ kind: "leaf", threadId: "t1" }, "t1"))).toBe(false);
  });

  it("accepts the panes that are not terminals", () => {
    for (const content of [
      { kind: "dashboard" },
      { kind: "git" },
      { kind: "explorer" },
      { kind: "todo" },
      { kind: "editor" },
      { kind: "browser", url: "http://localhost:5173/" },
    ]) {
      expect(isPaneGroup(group(panel("pane-1", content), "pane-1"))).toBe(true);
    }
  });

  it("rejects a leaf whose content is malformed", () => {
    for (const content of [
      undefined,
      null,
      "git",
      {},
      { kind: "wormhole" },
      // A browser pane with nowhere to go and a thread pane with no thread both
      // survive validation and then crash the pane that draws them.
      { kind: "browser" },
      { kind: "browser", url: 42 },
      { kind: "thread" },
      { kind: "thread", threadId: 7 },
    ]) {
      expect(isPaneGroup(group(panel("pane-1", content), "pane-1"))).toBe(false);
    }
  });

  it("rejects a thread pane that is not named after its thread", () => {
    const root = panel("pane-1", { kind: "thread", threadId: "t1" });
    expect(isPaneGroup(group(root, "pane-1"))).toBe(false);
  });
});
