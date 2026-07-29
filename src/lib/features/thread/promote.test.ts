import { describe, expect, it } from "vitest";
import { parsePromotion } from "./promote";

const wrap = (payload: unknown) => `boite;launch=${JSON.stringify(payload)}`;

describe("parsePromotion", () => {
  it("reads a launcher naming what it became", () => {
    expect(
      parsePromotion(
        wrap({ cmd: "fastpick", args: ["--harness", "claude-code"], iconKey: "claude", label: "Claude Code" }),
      ),
    ).toEqual({
      cmd: "fastpick",
      args: ["--harness", "claude-code"],
      iconKey: "claude",
      label: "Claude Code",
    });
  });

  it("leaves another program's OSC 1337 alone", () => {
    expect(parsePromotion("CurrentDir=/home/x")).toBeNull();
    expect(parsePromotion("SetBadgeFormat=abc")).toBeNull();
  });

  it("drops a payload that is not JSON", () => {
    expect(parsePromotion("boite;launch=not json")).toBeNull();
  });

  it("refuses a promotion with no command", () => {
    expect(parsePromotion(wrap({ args: [], iconKey: "claude" }))).toBeNull();
    expect(parsePromotion(wrap({ cmd: "   ", iconKey: "claude" }))).toBeNull();
  });

  it("refuses arguments that are not all strings", () => {
    expect(parsePromotion(wrap({ cmd: "x", args: ["a", 3] }))).toBeNull();
  });

  it("falls back to no glyph for an icon it does not know", () => {
    expect(parsePromotion(wrap({ cmd: "x", args: [], iconKey: "wat" }))?.iconKey).toBeNull();
  });

  it("bounds what a terminal can push at it", () => {
    expect(parsePromotion(wrap({ cmd: "x", args: Array(200).fill("a") }))).toBeNull();
    expect(parsePromotion(`boite;launch=${"x".repeat(9000)}`)).toBeNull();
  });

  it("treats a blank label as none, so the thread keeps its own", () => {
    expect(parsePromotion(wrap({ cmd: "x", args: [], label: "  " }))?.label).toBeUndefined();
  });
});
