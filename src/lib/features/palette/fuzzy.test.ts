import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

const score = (q: string, t: string) => fuzzyScore(q, t);

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(score("zzz", "New folder")).toBeNull();
    expect(score("fn", "New folder")).toBeNull();
  });

  it("scores an empty query as neutral rather than rejecting it", () => {
    expect(score("", "anything")).toBe(0);
  });

  it("matches a subsequence spread across the text", () => {
    expect(score("nf", "New folder")).not.toBeNull();
  });

  it("ranks word starts above mid-word matches", () => {
    const wordStart = score("nf", "New folder")!;
    const midWord = score("nf", "unfold")!;
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("ranks a consecutive run above a scattered match", () => {
    const consecutive = score("git", "git status")!;
    const scattered = score("git", "go into terminal")!;
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
    const midWord = score("s", "assorted")!;
    expect(afterSlash).toBeGreaterThan(midWord);
  });

  it("stays stable across repeated calls once the fold cache is warm", () => {
    const first = score("thr", "New thread");
    for (let i = 0; i < 50; i++) score("thr", "New thread");
    expect(score("thr", "New thread")).toBe(first);
  });
});
