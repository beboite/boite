import { describe, expect, it } from "vitest";
import type { WorkspaceHit } from "$lib/backend/types";
import { MAX_CONTENT_ROWS, contentRowId, tidyExcerpt, usableHits } from "./content";

const hit = (over: Partial<WorkspaceHit> = {}): WorkspaceHit => ({
  kind: "transcript",
  projectId: "",
  refId: "t1",
  excerpt: "error[E0432]: unresolved import",
  ...over,
});

describe("an excerpt on its way to a row", () => {
  it("collapses the whitespace a terminal left in it", () => {
    expect(tidyExcerpt("  cargo\tbuild\n  --release  ")).toBe("cargo build --release");
  });

  /** A build that failed rang the bell, and the row is not the place for it. */
  it("drops the control characters that survive escape stripping", () => {
    expect(tidyExcerpt("done\u0007\u0008 here")).toBe("done here");
  });

  it("cuts a long line rather than letting it set the row's width", () => {
    const long = tidyExcerpt("x".repeat(400));
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves a line that is already short alone", () => {
    expect(tidyExcerpt("fix/ci-gate landed")).toBe("fix/ci-gate landed");
  });
});

describe("what reaches the list", () => {
  /**
   * The reference alone is not a key. A transcript hit names its thread, so a
   * terminal that printed the word on twenty lines answers with twenty hits
   * carrying one id between them.
   */
  it("gives two lines of the same transcript two ids", () => {
    expect(contentRowId(hit(), 0)).not.toBe(contentRowId(hit(), 1));
  });

  it("keeps the order the backend ranked in", () => {
    const hits = [
      hit({ kind: "todo", refId: "a", excerpt: "first" }),
      hit({ kind: "todo", refId: "b", excerpt: "second" }),
      hit({ kind: "todo", refId: "c", excerpt: "third" }),
    ];
    expect(usableHits(hits).map((h) => h.refId)).toEqual(["a", "b", "c"]);
  });

  /** A progress bar that redrew itself is two hundred identical lines on disk. */
  it("keeps one copy of a line a terminal printed over and over", () => {
    const repeated = Array.from({ length: 30 }, () => hit({ excerpt: "building…" }));
    expect(usableHits(repeated)).toHaveLength(1);
  });

  it("still tells two threads printing the same line apart", () => {
    const both = [hit({ refId: "t1" }), hit({ refId: "t2" })];
    expect(usableHits(both)).toHaveLength(2);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      hit({ refId: `t${i}`, excerpt: `line ${i}` }),
    );
    expect(usableHits(many)).toHaveLength(MAX_CONTENT_ROWS);
  });

  it("drops a hit whose excerpt was nothing but control characters", () => {
    expect(usableHits([hit({ excerpt: "\u0007\u0000" })])).toEqual([]);
  });

  it("hands back the tidied text rather than the raw one", () => {
    expect(usableHits([hit({ excerpt: " a\tb " })])[0].excerpt).toBe("a b");
  });
});
