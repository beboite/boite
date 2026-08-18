import { describe, expect, it } from "vitest";
import { visibleDelegationRows } from "./delegation-stack";

const t = (id: string, parent?: string) => ({
  id,
  parentThreadId: parent ?? null,
});

describe("visibleDelegationRows", () => {
  it("draws every thread when none is a child of another in the list", () => {
    const rows = visibleDelegationRows([t("a"), t("b")], {});
    expect(rows.map((r) => r.thread.id)).toEqual(["a", "b"]);
    expect(rows.every((r) => !r.expandable && r.stack.length === 0)).toBe(true);
  });

  it("keeps children on the parent until that parent is opened", () => {
    const rows = visibleDelegationRows(
      [t("p"), t("c1", "p"), t("c2", "p")],
      {},
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].thread.id).toBe("p");
    expect(rows[0].stack.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(rows[0].foldedCount).toBe(2);
    expect(rows[0].expandable).toBe(true);
  });

  it("reveals only the direct children when the parent opens", () => {
    const rows = visibleDelegationRows(
      [t("p"), t("c", "p"), t("g", "c")],
      { p: true },
    );
    expect(rows.map((r) => [r.thread.id, r.depth, r.stack.map((s) => s.id)])).toEqual([
      ["p", 0, []],
      ["c", 1, ["g"]],
    ]);
    expect(rows[1].foldedCount).toBe(1);
  });

  it("takes a second open to reveal a grandchild", () => {
    const rows = visibleDelegationRows(
      [t("p"), t("c", "p"), t("g", "c")],
      { p: true, c: true },
    );
    expect(rows.map((r) => [r.thread.id, r.depth, r.expandable])).toEqual([
      ["p", 0, true],
      ["c", 1, true],
      ["g", 2, false],
    ]);
  });

  it("counts every descendant on a folded parent", () => {
    const rows = visibleDelegationRows(
      [t("p"), t("c", "p"), t("g1", "c"), t("g2", "c")],
      {},
    );
    expect(rows[0].stack.map((s) => s.id)).toEqual(["c"]);
    expect(rows[0].foldedCount).toBe(3);
  });

  it("draws an orphan at the root rather than dropping it", () => {
    const rows = visibleDelegationRows([t("c", "missing")], {});
    expect(rows.map((r) => r.thread.id)).toEqual(["c"]);
    expect(rows[0].depth).toBe(0);
  });

  it("does not walk a cycle", () => {
    const rows = visibleDelegationRows(
      [
        { id: "a", parentThreadId: "b" },
        { id: "b", parentThreadId: "a" },
      ],
      { a: true, b: true },
    );
    expect(rows.map((r) => r.thread.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores an expanded flag on a thread with no children in the list", () => {
    const rows = visibleDelegationRows([t("p")], { p: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].expandable).toBe(false);
  });
});
