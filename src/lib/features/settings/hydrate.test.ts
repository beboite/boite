import { describe, expect, it } from "vitest";
import {
  keepArray,
  keepAtLeastZero,
  keepBoolean,
  keepBounded,
  keepClamped,
  keepFraction,
  keepIf,
  keepMerged,
  keepNonBlank,
  keepNonEmpty,
  keepPositive,
  keepRecord,
  keepString,
} from "./hydrate";

// The helpers differ from each other by one operator, which is exactly what
// made the fifty inline copies they replaced unreadable. What is worth pinning
// is where two neighbours disagree: "" against a blank, 0 against above zero,
// a floor that falls back against a ceiling that clamps.

describe("keepBoolean", () => {
  it("keeps either boolean and refuses anything wearing one's clothes", () => {
    expect(keepBoolean(false, true)).toBe(false);
    expect(keepBoolean("true", false)).toBe(false);
    expect(keepBoolean(undefined, true)).toBe(true);
  });
});

describe("the three string reads", () => {
  it("keepString takes an empty string, where empty is a real answer", () => {
    expect(keepString("", null)).toBe("");
    expect(keepString(7, null)).toBe(null);
  });

  it("keepNonEmpty refuses only the empty string", () => {
    expect(keepNonEmpty("", null)).toBe(null);
    expect(keepNonEmpty("   ", null)).toBe("   ");
  });

  it("keepNonBlank refuses a blank and returns the rest untouched", () => {
    expect(keepNonBlank("  \n ", "fallback")).toBe("fallback");
    // The trim decides, it does not rewrite: a template's leading blank line
    // is the author's and survives the read.
    expect(keepNonBlank("\nhello ", "fallback")).toBe("\nhello ");
  });
});

describe("the number reads", () => {
  it("keepPositive treats zero as a collapsed width, not a choice", () => {
    expect(keepPositive(0, 240)).toBe(240);
    expect(keepPositive(-1, 240)).toBe(240);
    expect(keepPositive(320, 240)).toBe(320);
  });

  it("keepAtLeastZero keeps the zero that spells no cap", () => {
    expect(keepAtLeastZero(0, 10)).toBe(0);
    expect(keepAtLeastZero(-1, 10)).toBe(10);
    expect(keepAtLeastZero(Number.NaN, 10)).toBe(10);
  });

  it("keepFraction refuses both edges, since 0 and 1 hide a pane", () => {
    expect(keepFraction(0, 0.5)).toBe(0.5);
    expect(keepFraction(1, 0.5)).toBe(0.5);
    expect(keepFraction(0.25, 0.5)).toBe(0.25);
  });

  it("keepBounded falls back under the floor and clamps over the ceiling", () => {
    expect(keepBounded(5, 30, 3600, 180)).toBe(180);
    expect(keepBounded(99999, 30, 3600, 180)).toBe(3600);
    expect(keepBounded(60, 30, 3600, 180)).toBe(60);
  });

  it("keepClamped hands a stored number to the feature's own clamp", () => {
    const clamp = (n: number) => Math.min(200, Math.max(50, n));
    expect(keepClamped(1000, clamp, 100)).toBe(200);
    expect(keepClamped("120", clamp, 100)).toBe(100);
  });
});

describe("keepIf", () => {
  const isOn = (v: unknown): v is "on" => v === "on";

  it("defers to the guard rather than to a type check", () => {
    expect(keepIf("on", isOn, "off")).toBe("on");
    expect(keepIf("maybe", isOn, "off")).toBe("off");
  });
});

describe("the collection reads", () => {
  it("keepArray takes the stored array and copies the fallback", () => {
    const fallback: string[] = [];
    expect(keepArray(["a"], fallback)).toEqual(["a"]);
    // Copied, never shared: a mutation of the hydrated value must not reach
    // the DEFAULTS every later read falls back to.
    expect(keepArray("nope", fallback)).not.toBe(fallback);
  });

  it("keepRecord trusts the stored map and refuses null", () => {
    const stored = { a: ["x"] };
    expect(keepRecord(stored, {})).toBe(stored);
    expect(keepRecord(null, { a: ["x"] })).toEqual({ a: ["x"] });
  });

  it("keepMerged fills the keys the stored map predates", () => {
    expect(keepMerged({ claude: false }, { claude: true, codex: true })).toEqual({
      claude: false,
      codex: true,
    });
    expect(keepMerged(42, { claude: true })).toEqual({ claude: true });
  });
});
