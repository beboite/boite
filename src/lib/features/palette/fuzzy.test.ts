import { describe, expect, it } from "vitest";
import { fuzzyScore, highlightSegments, type FuzzyOpts } from "./fuzzy";

const score = (q: string, t: string, opts?: FuzzyOpts) => fuzzyScore(q, t, opts)?.score ?? null;

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(score("zzz", "New folder")).toBeNull();
    expect(score("fn", "New folder")).toBeNull();
  });

  it("scores an empty query as neutral rather than rejecting it", () => {
    expect(score("", "anything")).toBe(0);
  });

  it("matches a subsequence spread across the text when fuzzy option is enabled", () => {
    expect(score("nf", "New folder", { fuzzy: true })).not.toBeNull();
  });

  it("ranks word starts above mid-word matches", () => {
    const wordStart = score("nf", "New folder", { fuzzy: true })!;
    const midWord = score("nf", "unfold", { fuzzy: true })!;
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("ranks a consecutive run above a scattered match", () => {
    const consecutive = score("git", "git status")!;
    const scattered = score("git", "go into terminal", { fuzzy: true })!;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it("prefers the shorter of two otherwise equal matches", () => {
    const short = score("set", "Settings")!;
    const long = score("set", "Settings and preferences panel")!;
    expect(short).toBeGreaterThan(long);
  });

  it("is case-insensitive", () => {
    expect(score("GIT", "git status")).toBe(score("git", "GIT STATUS"));
  });

  it("folds diacritics so an unaccented query still matches", () => {
    expect(score("parametres", "Paramètres")).not.toBeNull();
    expect(score("e", "é")).not.toBeNull();
  });

  it("treats / and - as word boundaries", () => {
    const afterSlash = score("s", "lib/store")!;
    const midWord = score("s", "assorted", { fuzzy: true })!;
    expect(afterSlash).toBeGreaterThan(midWord);
  });

  it("stays stable across repeated calls once the fold cache is warm", () => {
    const first = score("thr", "New thread");
    for (let i = 0; i < 50; i++) score("thr", "New thread");
    expect(score("thr", "New thread")).toBe(first);
  });

  // Audit regressions
  it("does not match 'confirm' on 'Fetch toutes les 3 min'", () => {
    expect(fuzzyScore("confirm", "Fetch toutes les 3 min")).toBeNull();
    expect(fuzzyScore("confirm", "Fetch toutes les 3 min", { fuzzy: true })).toBeNull();
  });

  it("does not match 'thread' on 'Test bash sleep command for 40 seconds'", () => {
    expect(fuzzyScore("thread", "Test bash sleep command for 40 seconds")).toBeNull();
    expect(fuzzyScore("thread", "Test bash sleep command for 40 seconds", { fuzzy: true })).toBeNull();
  });

  it("matches accents: 'reglages' matches 'Réglages'", () => {
    const res = fuzzyScore("reglages", "Réglages");
    expect(res).not.toBeNull();
    expect(res!.ranges).toEqual([[0, 8]]);
  });

  it("ranks exact word match above word-prefix match", () => {
    const exact = score("thread", "New thread")!;
    const prefix = score("thr", "New thread")!;
    expect(exact).toBeGreaterThan(prefix);
  });

  it("ranks word-prefix match above subsequence match", () => {
    const prefix = score("thr", "New thread")!;
    const sub = score("nt", "New thread", { fuzzy: true })!;
    expect(prefix).toBeGreaterThan(sub);
  });

  it("matches word prefixes in any order", () => {
    const res = fuzzyScore("status git", "git status");
    expect(res).not.toBeNull();
    expect(res!.ranges).toEqual([
      [0, 3],
      [4, 10],
    ]);
  });

  it("requires all query tokens to match", () => {
    expect(fuzzyScore("git missing", "git status")).toBeNull();
  });

  it("restricts subsequence matching to span <= query.length + 6", () => {
    // query length 3 -> max span 9
    // "a1234567bc" has 'a' at 0, 'b' at 8, 'c' at 9 -> span 10 > 9
    expect(fuzzyScore("abc", "a1234567bc", { fuzzy: true })).toBeNull();
    // "a123456bc" has 'a' at 0, 'b' at 7, 'c' at 8 -> span 9 <= 9
    expect(fuzzyScore("abc", "a123456bc", { fuzzy: true })).not.toBeNull();
  });

  it("does not perform subsequence match when fuzzy option is false or omitted", () => {
    expect(fuzzyScore("nf", "New folder")).toBeNull();
    expect(fuzzyScore("nf", "New folder", { fuzzy: false })).toBeNull();
  });
});

describe("highlightSegments", () => {
  it("returns single unmatched segment when ranges is empty or undefined", () => {
    expect(highlightSegments("hello")).toEqual([{ text: "hello", matched: false }]);
    expect(highlightSegments("hello", [])).toEqual([{ text: "hello", matched: false }]);
  });

  it("splits text into matched and unmatched segments", () => {
    expect(highlightSegments("New folder", [[0, 3], [4, 7]])).toEqual([
      { text: "New", matched: true },
      { text: " ", matched: false },
      { text: "fol", matched: true },
      { text: "der", matched: false },
    ]);
  });

  it("handles match at start and match at end", () => {
    expect(highlightSegments("hello", [[0, 2]])).toEqual([
      { text: "he", matched: true },
      { text: "llo", matched: false },
    ]);
    expect(highlightSegments("hello", [[3, 5]])).toEqual([
      { text: "hel", matched: false },
      { text: "lo", matched: true },
    ]);
  });

  it("handles full match", () => {
    expect(highlightSegments("hello", [[0, 5]])).toEqual([{ text: "hello", matched: true }]);
  });

  it("merges overlapping and adjacent ranges", () => {
    expect(highlightSegments("hello", [[1, 3], [2, 4]])).toEqual([
      { text: "h", matched: false },
      { text: "ell", matched: true },
      { text: "o", matched: false },
    ]);
    expect(highlightSegments("hello", [[0, 2], [2, 4]])).toEqual([
      { text: "hell", matched: true },
      { text: "o", matched: false },
    ]);
  });
});

