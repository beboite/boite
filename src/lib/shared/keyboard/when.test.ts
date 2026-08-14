import { describe, expect, it } from "vitest";
import { compileWhen, evaluateWhen, parseWhen, whenKeys, whenOverlaps } from "./when";

const run = (src: string, ctx: Record<string, boolean>) => compileWhen(src).test(ctx);

describe("parseWhen", () => {
  it("treats an empty clause as always true", () => {
    for (const src of [undefined, null, "", "   "]) {
      expect(compileWhen(src).test({})).toBe(true);
    }
  });

  it("reads a bare key", () => {
    expect(run("terminalFocus", { terminalFocus: true })).toBe(true);
    expect(run("terminalFocus", { terminalFocus: false })).toBe(false);
  });

  it("evaluates an unknown key as false instead of throwing", () => {
    expect(run("neverHeardOfIt", {})).toBe(false);
    expect(run("!neverHeardOfIt", {})).toBe(true);
    expect(run("terminalFocus && neverHeardOfIt", { terminalFocus: true })).toBe(false);
  });

  it("reads a key set to something other than true as false", () => {
    // The context comes off a store, and a stray undefined must not read as a
    // truthy match.
    expect(run("editorFocus", { editorFocus: undefined as unknown as boolean })).toBe(
      false,
    );
  });

  it("binds && tighter than ||", () => {
    // a || (b && c), never (a || b) && c.
    expect(run("a || b && c", { a: true, b: false, c: false })).toBe(true);
    expect(run("a || b && c", { a: false, b: true, c: false })).toBe(false);
    expect(run("a || b && c", { a: false, b: true, c: true })).toBe(true);
  });

  it("binds ! tighter than both", () => {
    expect(run("!a && b", { a: false, b: true })).toBe(true);
    expect(run("!a && b", { a: true, b: true })).toBe(false);
    expect(run("!!a", { a: true })).toBe(true);
  });

  it("honours parentheses", () => {
    expect(run("(a || b) && c", { a: true, b: false, c: false })).toBe(false);
    expect(run("(a || b) && c", { a: true, b: false, c: true })).toBe(true);
    expect(run("!(a || b)", { a: false, b: false })).toBe(true);
    expect(run("!(a || b)", { a: true, b: false })).toBe(false);
  });

  it("knows the two literals", () => {
    expect(run("true", {})).toBe(true);
    expect(run("false", {})).toBe(false);
    expect(run("false || a", { a: true })).toBe(true);
  });

  it("accepts dotted keys and ignores whitespace", () => {
    expect(run("  view.editor   &&\n!overlayOpen ", { "view.editor": true })).toBe(true);
  });

  it("returns null on a syntax error rather than throwing", () => {
    for (const src of ["a &&", "(a", "a )", "&& a", "a b", "a $ b", "!", "a ||"]) {
      expect(parseWhen(src)).toBeNull();
    }
  });

  it("compiles an unparseable clause to a rule that never fires", () => {
    // The other reading — treating a typo as `true` — would hand a broken rule
    // every context in the app.
    const compiled = compileWhen("a &&");
    expect(compiled.ok).toBe(false);
    expect(compiled.test({ a: true })).toBe(false);
  });

  it("does not evaluate anything that looks like code", () => {
    expect(parseWhen("globalThis.alert(1)")).toBeNull();
    expect(parseWhen("a; b")).toBeNull();
    expect(parseWhen("a === b")).toBeNull();
  });
});

describe("evaluateWhen", () => {
  it("walks a hand-built tree", () => {
    const node = parseWhen("a && !b");
    expect(node).not.toBeNull();
    expect(evaluateWhen(node!, { a: true, b: false })).toBe(true);
    expect(evaluateWhen(node!, { a: true, b: true })).toBe(false);
  });
});

describe("whenKeys", () => {
  it("collects every key a clause mentions, and no literal", () => {
    expect([...whenKeys(parseWhen("(a || b) && !c || true")!)].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("whenOverlaps", () => {
  it("says two clauses that can both hold overlap", () => {
    expect(whenOverlaps("terminalFocus", "!overlayOpen")).toBe(true);
    expect(whenOverlaps(undefined, "terminalFocus")).toBe(true);
    expect(whenOverlaps(undefined, undefined)).toBe(true);
  });

  it("says two clauses that cannot both hold do not", () => {
    expect(whenOverlaps("terminalFocus", "!terminalFocus")).toBe(false);
    expect(whenOverlaps("a && b", "a && !b")).toBe(false);
    expect(whenOverlaps("settingsOpen && !overlayOpen", "overlayOpen")).toBe(false);
  });

  it("treats an unparseable clause as overlapping nothing", () => {
    expect(whenOverlaps("a &&", "a")).toBe(false);
  });
});
