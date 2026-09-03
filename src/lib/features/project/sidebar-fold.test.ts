import { describe, expect, it } from "vitest";
import { FOLD_LIMIT, foldRows } from "./sidebar-fold";

interface Row {
  id: string;
  depth: number;
  live?: boolean;
}

const flat = (n: number, live: string[] = []): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    depth: 0,
    live: live.includes(`t${i + 1}`),
  }));

const ids = (rows: Row[]) => rows.map((r) => r.id);
const isLive = (r: Row) => r.live === true;

describe("folding a project's rows", () => {
  it("leaves a short list alone", () => {
    const out = foldRows(flat(FOLD_LIMIT), isLive, false);
    expect(ids(out.rows)).toEqual(ids(flat(FOLD_LIMIT)));
    expect(out.hidden).toBe(0);
  });

  it("keeps the first ten and counts the rest", () => {
    const out = foldRows(flat(24), isLive, false);
    expect(out.rows).toHaveLength(10);
    expect(ids(out.rows)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]);
    expect(out.hidden).toBe(14);
  });

  it("draws everything once the group is expanded", () => {
    const out = foldRows(flat(24), isLive, true);
    expect(out.rows).toHaveLength(24);
    expect(out.hidden).toBe(0);
  });

  /**
   * The whole point of the cap: a fold that hid a working agent would be a
   * sidebar lying about what the machine is doing.
   */
  it("pulls live work above the fold and still shows ten", () => {
    const out = foldRows(flat(24, ["t15", "t22"]), isLive, false);
    expect(out.rows).toHaveLength(10);
    expect(ids(out.rows)).toContain("t15");
    expect(ids(out.rows)).toContain("t22");
    expect(out.hidden).toBe(14);
  });

  it("keeps the order it was given", () => {
    const out = foldRows(flat(24, ["t15"]), isLive, false);
    expect(ids(out.rows)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t15"]);
  });

  it("draws every live row even past the cap", () => {
    const live = Array.from({ length: 14 }, (_, i) => `t${i + 10}`);
    const out = foldRows(flat(24, live), isLive, false);
    expect(out.rows).toHaveLength(14);
    expect(out.hidden).toBe(10);
  });

  /**
   * A depth-1 row is a delegated child drawn under its parent. Cutting between
   * the two leaves an indented row under nothing.
   */
  it("never separates a parent from its opened children", () => {
    const rows: Row[] = [
      ...flat(9),
      { id: "parent", depth: 0 },
      { id: "child", depth: 1 },
      { id: "tail", depth: 0 },
    ];
    const out = foldRows(rows, isLive, false);
    expect(ids(out.rows)).toEqual(ids(flat(9)));
    expect(out.hidden).toBe(3);
  });

  it("takes a whole family when a child of it is live", () => {
    const rows: Row[] = [
      ...flat(9),
      { id: "parent", depth: 0 },
      { id: "child", depth: 1, live: true },
      { id: "tail", depth: 0 },
    ];
    const out = foldRows(rows, isLive, false);
    expect(ids(out.rows)).toContain("parent");
    expect(ids(out.rows)).toContain("child");
    expect(ids(out.rows)).not.toContain("tail");
  });
});
