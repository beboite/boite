import { describe, expect, it } from "vitest";
import { rankRows, sectionTitleKeyAt, type PaletteRow } from "./rank";
import type { PaletteSection } from "./sections";

function row(
  id: string,
  section: PaletteSection,
  label: string,
  hint: string | null = null,
): PaletteRow {
  return { c: { id, section, run: () => {} }, label, hint };
}

const ids = (rows: PaletteRow[]) => rows.map((r) => r.c.id);

describe("with nothing typed", () => {
  it("draws the sections in their declared order, whatever order it was given", () => {
    const rows = [
      row("p1", "projects", "boite"),
      row("t1", "threads", "Claude #1"),
      row("a1", "actions", "New terminal"),
      row("n1", "panes", "Open editor"),
    ];
    expect(ids(rankRows(rows, ""))).toEqual(["t1", "a1", "n1", "p1"]);
  });

  it("treats whitespace as nothing typed", () => {
    const rows = [row("p1", "projects", "boite"), row("t1", "threads", "Claude #1")];
    expect(ids(rankRows(rows, "   "))).toEqual(["t1", "p1"]);
  });
});

describe("with a query", () => {
  it("drops what does not match at all", () => {
    const rows = [row("t1", "threads", "worktree pool"), row("t2", "threads", "editor")];
    expect(ids(rankRows(rows, "worktree"))).toEqual(["t1"]);
  });

  /** The bias is the whole point of having one: same text, different section. */
  it("puts a thread above an action of the same text", () => {
    const rows = [
      row("a1", "actions", "Open editor"),
      row("t1", "threads", "Open editor"),
      row("p1", "projects", "Open editor"),
    ];
    expect(ids(rankRows(rows, "editor"))).toEqual(["t1", "a1", "p1"]);
  });

  it("matches the hint as well as the label", () => {
    const rows = [row("t1", "threads", "Claude #1", "boite / shell")];
    expect(ids(rankRows(rows, "boite"))).toEqual(["t1"]);
  });
});

describe("content hits", () => {
  /**
   * They are never scored. FTS5 and the transcript scan already ranked them,
   * and an excerpt re-scored against the same query would sort by how early the
   * word happens to appear in a sentence.
   */
  it("follow every command, in the order the backend gave them", () => {
    const rows = [
      row("c1", "content", "zzz nothing like the query"),
      row("c2", "content", "worktree worktree worktree"),
      row("t1", "threads", "worktree pool"),
    ];
    expect(ids(rankRows(rows, "worktree"))).toEqual(["t1", "c1", "c2"]);
  });

  /** A hit that does not read like the query is still a hit: the backend found
      it by stemming or across two columns, and this side cannot re-derive that. */
  it("are kept even when the query is not a subsequence of the excerpt", () => {
    const rows = [row("c1", "content", "denied branch reserve")];
    expect(ids(rankRows(rows, "worktree"))).toEqual(["c1"]);
  });

  it("are absent from the list before anything is typed only because nothing asked", () => {
    const rows = [row("c1", "content", "an excerpt"), row("t1", "threads", "a thread")];
    // Nothing filters them out with an empty query; the store simply holds none.
    expect(ids(rankRows(rows, ""))).toEqual(["t1", "c1"]);
  });
});

describe("section headers", () => {
  const ranked = rankRows(
    [
      row("t1", "threads", "one"),
      row("t2", "threads", "two"),
      row("a1", "actions", "three"),
      row("c1", "content", "four"),
    ],
    "",
  );

  it("names a section on its first row and nowhere else in it", () => {
    expect(sectionTitleKeyAt(ranked, 0)).toBe("project.threads");
    expect(sectionTitleKeyAt(ranked, 1)).toBeNull();
    expect(sectionTitleKeyAt(ranked, 2)).toBe("palette.sectionActions");
  });

  it("gives content hits a header of their own", () => {
    expect(sectionTitleKeyAt(ranked, 3)).toBe("palette.sectionContent");
  });

  it("says nothing about a row that is not there", () => {
    expect(sectionTitleKeyAt(ranked, 9)).toBeNull();
  });
});
