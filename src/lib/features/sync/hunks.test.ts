import { describe, expect, it } from "vitest";

import {
  applyChoice,
  buildHunks,
  compose,
  defaultChoices,
  fillUndecided,
  undecided,
  unionSafeSyntax,
  type Choice,
} from "./hunks";

const all = (hunks: unknown[], choice: Choice): Choice[] => hunks.map(() => choice);

describe("buildHunks", () => {
  it("finds one difference where one line changed", () => {
    const hunks = buildHunks("a\nb\nc\n", "a\nx\nc\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].mineText).toBe("b\n");
    expect(hunks[0].theirsText).toBe("x\n");
    expect(hunks[0].kind).toBe("changed");
  });

  it("reads an insertion on the other side as added, and a deletion as removed", () => {
    expect(buildHunks("b\nc\n", "a\nb\nc\n")[0].kind).toBe("added");
    expect(buildHunks("a\nb\nc\n", "a\nb\n")[0].kind).toBe("removed");
  });

  it("clamps offsets that point past the end of a file with no trailing newline", () => {
    // Chunk documents that toA/toB may be one past the end, and a file without a
    // final newline is where it happens. Unclamped, the slice runs off the end.
    const hunks = buildHunks("a\nb", "a\nz");
    expect(hunks[0].toA).toBeLessThanOrEqual("a\nb".length);
    expect(hunks[0].mineText).toBe("b");
    expect(hunks[0].theirsText).toBe("z");
  });

  it("handles one side being empty", () => {
    const hunks = buildHunks("", "a\nb\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].mineText).toBe("");
    expect(hunks[0].theirsText).toBe("a\nb\n");
  });

  it("finds each difference separately", () => {
    expect(buildHunks("a\nb\nc\nd\ne\n", "a\nX\nc\nY\ne\n")).toHaveLength(2);
  });

  it("finds nothing in two identical files", () => {
    expect(buildHunks("same\n", "same\n")).toHaveLength(0);
  });
});

describe("compose", () => {
  const mine = "a\nb\nc\nd\ne\n";
  const theirs = "a\nX\nc\nY\ne\n";

  // The two anti-corruption tests. Exact, because "close enough" here means a
  // configuration file that no longer parses on somebody's other machine.
  it("keeping every side of mine reproduces mine byte for byte", () => {
    const hunks = buildHunks(mine, theirs);
    expect(compose(mine, theirs, hunks, all(hunks, "mine"))).toBe(mine);
  });

  it("keeping every side of theirs reproduces theirs byte for byte", () => {
    const hunks = buildHunks(mine, theirs);
    expect(compose(mine, theirs, hunks, all(hunks, "theirs"))).toBe(theirs);
  });

  it("keeps both sides, mine first, with one newline between them", () => {
    // Two paragraphs of the shape ~/.agents/AGENTS.md actually has.
    const ours = "# rules\n\nAlways answer in French.\n";
    const yours = "# rules\n\nAlways run the tests.\n";
    const hunks = buildHunks(ours, yours);
    const merged = compose(ours, yours, hunks, all(hunks, "both"));
    expect(merged).toContain("Always answer in French.");
    expect(merged).toContain("Always run the tests.");
    expect(merged.indexOf("French")).toBeLessThan(merged.indexOf("tests"));
    expect(merged).not.toContain("French.Always");
    expect(merged).not.toContain("\n\n\n\n");
  });

  it("keeps both sides the other way round on request", () => {
    const ours = "# rules\n\nAlways answer in French.\n";
    const yours = "# rules\n\nAlways run the tests.\n";
    const hunks = buildHunks(ours, yours);
    const merged = compose(ours, yours, hunks, all(hunks, "bothReversed"));
    expect(merged.indexOf("tests")).toBeLessThan(merged.indexOf("French"));
  });

  it("does not double a newline that is already there", () => {
    const hunks = buildHunks("one\n", "two\n");
    expect(compose("one\n", "two\n", hunks, ["both"])).toBe("one\ntwo\n");
  });

  it("adds no newline when one side is empty", () => {
    const hunks = buildHunks("a\nc\n", "a\nb\nc\n");
    expect(compose("a\nc\n", "a\nb\nc\n", hunks, ["both"])).toBe("a\nb\nc\n");
  });

  it("leaves the runs between differences exactly as they were", () => {
    const hunks = buildHunks(mine, theirs);
    const merged = compose(mine, theirs, hunks, ["theirs", "mine"]);
    expect(merged).toBe("a\nX\nc\nd\ne\n");
  });

  it("mixes choices across three differences without disturbing the rest", () => {
    const ours = "1\nA\n2\nB\n3\nC\n4\n";
    const yours = "1\nX\n2\nY\n3\nZ\n4\n";
    const hunks = buildHunks(ours, yours);
    expect(hunks).toHaveLength(3);
    const merged = compose(ours, yours, hunks, ["mine", "theirs", "both"]);
    expect(merged).toBe("1\nA\n2\nY\n3\nC\nZ\n4\n");
  });

  it("leaves an undecided difference as this machine has it", () => {
    const hunks = buildHunks(mine, theirs);
    expect(compose(mine, theirs, hunks, [null, null])).toBe(mine);
  });
});

describe("choices", () => {
  it("starts on both for a file where stacking can be read back", () => {
    const hunks = buildHunks("a\nb\n", "a\nc\n");
    expect(defaultChoices(hunks, true)).toEqual(["both"]);
    expect(undecided(defaultChoices(hunks, true))).toBe(0);
  });

  it("starts undecided where stacking would be a syntax error", () => {
    const hunks = buildHunks("a\nb\n", "a\nc\n");
    expect(defaultChoices(hunks, false)).toEqual([null]);
    expect(undecided(defaultChoices(hunks, false))).toBe(1);
  });

  it("decides one difference and leaves the others alone", () => {
    const before: Choice[] = [null, "mine", null];
    expect(applyChoice(before, 2, "theirs")).toEqual([null, "mine", "theirs"]);
    expect(before).toEqual([null, "mine", null]);
  });

  it("ignores an index nobody has", () => {
    const before: Choice[] = [null];
    expect(applyChoice(before, 7, "mine")).toEqual([null]);
  });

  it("fills what is undecided without changing what is not", () => {
    expect(fillUndecided([null, "theirs", null], "both")).toEqual([
      "both",
      "theirs",
      "both",
    ]);
  });

  it("knows which formats can hold both sides at once", () => {
    expect(unionSafeSyntax("markdown")).toBe(true);
    expect(unionSafeSyntax("text")).toBe(true);
    expect(unionSafeSyntax("json")).toBe(false);
    expect(unionSafeSyntax("jsonc")).toBe(false);
  });
});
