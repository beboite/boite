import { describe, expect, it } from "vitest";

import { stripComments, validate } from "./validate";

describe("validate", () => {
  it("accepts the file ~/.claude/settings.json actually is", () => {
    const settings = JSON.stringify(
      {
        model: "opus",
        enabledPlugins: { "caveman@caveman": true },
        effortLevel: "high",
        theme: "dark",
      },
      null,
      2,
    );
    expect(validate(settings, "json").ok).toBe(true);
  });

  // The test that proves the merge tool cannot ship a broken configuration:
  // stacking is exactly what "keep both" does, and on JSON it is a syntax error.
  it("refuses two JSON objects naively stacked, and says where", () => {
    const stacked = '{\n  "model": "opus"\n}\n{\n  "model": "sonnet"\n}\n';
    const verdict = validate(stacked, "json");
    expect(verdict.ok).toBe(false);
    expect(verdict.line).toBe(4);
    expect(verdict.message).toBeTruthy();
  });

  it("accepts a JSONC file with comments, and refuses the same text as JSON", () => {
    const jsonc = '// User settings\n{\n  "zeta": 1,\n  // about the theme\n  "theme": "dark"\n}\n';
    expect(validate(jsonc, "jsonc").ok).toBe(true);
    expect(validate(jsonc, "json").ok).toBe(false);
  });

  it("never checks a format that has no shape to break", () => {
    expect(validate("{ this is not json", "markdown").ok).toBe(true);
    expect(validate("{ this is not json", "text").ok).toBe(true);
  });

  it("catches a trailing comma, which JSONC tolerates in an editor and JSON does not", () => {
    expect(validate('{ "a": 1, }', "jsonc").ok).toBe(false);
  });
});

describe("stripComments", () => {
  // A URL in a value is the case a naive pass cuts in half, reporting a file
  // broken when it is fine.
  it("leaves a // inside a string alone", () => {
    const text = '{ "url": "https://example.com/x", "b": 1 }';
    expect(stripComments(text)).toBe(text);
    expect(validate(text, "jsonc").ok).toBe(true);
  });

  it("leaves an escaped quote inside a string alone", () => {
    const text = '{ "say": "he said \\"// no\\"", "b": 1 }';
    expect(validate(text, "jsonc").ok).toBe(true);
    expect(JSON.parse(stripComments(text)).say).toBe('he said "// no"');
  });

  it("keeps every offset where it was, so a reported line is the real one", () => {
    const text = '{\n  // a note\n  "a": 1,\n  "b": nope\n}\n';
    const stripped = stripComments(text);
    expect(stripped).toHaveLength(text.length);
    expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
    expect(validate(text, "jsonc").ok).toBe(false);
  });

  // Engines differ on how much they say. Where a line is offered it is used;
  // where none is, the message stands alone rather than a guess standing in for
  // it. Both are asserted, so a change of engine shows up here rather than as a
  // marker pointing at the wrong line in somebody's config.
  it("reports a line where the parser gives one", () => {
    const verdict = validate('{\n  "a": 1\n}\n{\n  "b": 2\n}\n', "json");
    expect(verdict.ok).toBe(false);
    expect(verdict.line).toBe(4);
  });

  it("reports no line rather than a wrong one where the parser gives none", () => {
    const verdict = validate('{\n  "a": 1,\n  "b": nope\n}\n', "json");
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toBeTruthy();
    expect(verdict.line).toBeUndefined();
  });

  it("strips a block comment and keeps the lines it spanned", () => {
    const text = '{\n  /* one\n     two */\n  "a": 1\n}\n';
    expect(validate(text, "jsonc").ok).toBe(true);
    expect(stripComments(text).split("\n")).toHaveLength(text.split("\n").length);
  });

  it("does not run off the end of an unterminated block comment", () => {
    expect(() => stripComments('{ "a": 1 /* never closed')).not.toThrow();
  });
});
