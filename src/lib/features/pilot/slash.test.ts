import { describe, expect, it } from "vitest";
import { applyHint, moveHint, slashHints, slashQuery } from "./slash";

const COMMANDS = ["init", "review", "compact", "compress-report", "resume"];

describe("slashQuery", () => {
  it("reads the prefix being typed", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/")).toBe("");
  });

  // A command with an argument is a command already chosen: the list has
  // nothing left to add, and a menu over the composer while somebody writes is
  // a menu in the way.
  it("closes once the command has an argument", () => {
    expect(slashQuery("/review src/app.css")).toBeNull();
    expect(slashQuery("/review ")).toBeNull();
  });

  it("ignores a slash that is not the whole box", () => {
    expect(slashQuery("a/b")).toBeNull();
    expect(slashQuery("look at\n/review")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("slashHints", () => {
  it("lists everything on a bare slash", () => {
    expect(slashHints("/", COMMANDS)).toEqual(COMMANDS);
  });

  it("ranks a prefix match above a match in the middle", () => {
    expect(slashHints("/re", COMMANDS)).toEqual(["review", "resume", "compress-report"]);
  });

  it("ignores case", () => {
    expect(slashHints("/REV", COMMANDS)).toEqual(["review"]);
  });

  it("drops the command already typed in full", () => {
    expect(slashHints("/review", COMMANDS)).toEqual([]);
  });

  it("offers nothing when nothing was declared, or nothing matches", () => {
    expect(slashHints("/re", [])).toEqual([]);
    expect(slashHints("/zzz", COMMANDS)).toEqual([]);
    expect(slashHints("hello", COMMANDS)).toEqual([]);
  });

  it("stops at the limit", () => {
    expect(slashHints("/", COMMANDS, 2)).toEqual(["init", "review"]);
  });
});

describe("applyHint", () => {
  it("writes the command back with room for its argument", () => {
    expect(applyHint("review")).toBe("/review ");
  });
});

describe("moveHint", () => {
  it("wraps at both ends", () => {
    expect(moveHint(0, 1, 3)).toBe(1);
    expect(moveHint(2, 1, 3)).toBe(0);
    expect(moveHint(0, -1, 3)).toBe(2);
    expect(moveHint(0, 1, 0)).toBe(0);
  });
});
