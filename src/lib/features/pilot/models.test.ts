import { describe, expect, it } from "vitest";
import {
  groupModels,
  isCurrentModel,
  modelLabel,
  newestAlias,
  resolveAlias,
} from "./models";

/**
 * `boite_pilot::claude::NATIVE_MODELS`, copied in the order the crate writes it.
 *
 * A copy rather than an import, because the crate is Rust and this is the shape
 * the catalog hands the webview. The order is the contract the grouping reads:
 * aliases first, then the full ids newest family first and newest version first
 * inside a family.
 */
const NATIVE = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-0",
  "claude-haiku-4-5",
];

describe("modelLabel", () => {
  it("names the four families the picker leads with", () => {
    expect(modelLabel("claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(modelLabel("claude-opus-5")).toBe("Claude Opus 5");
    expect(modelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
    expect(modelLabel("claude-opus-4-1")).toBe("Claude Opus 4.1");
  });

  it("names an alias without inventing a version for it", () => {
    expect(modelLabel("fable")).toBe("Claude Fable");
    expect(modelLabel("haiku")).toBe("Claude Haiku");
  });

  it("trims the provider a route id carries", () => {
    expect(modelLabel("anthropic/claude-opus-5")).toBe("Claude Opus 5");
  });

  // The rule that keeps a driver added later out of trouble: a name this file
  // never heard of is drawn as itself rather than as a guess.
  it("falls back to the id itself", () => {
    expect(modelLabel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(modelLabel("claude-mythos-5-preview")).toBe("claude-mythos-5-preview");
    expect(modelLabel(null)).toBe(null);
  });
});

describe("resolveAlias", () => {
  it("takes the first id of the family, which is the newest", () => {
    expect(resolveAlias("fable", NATIVE)).toBe("claude-fable-5-1");
    expect(resolveAlias("opus", NATIVE)).toBe("claude-opus-5");
    expect(resolveAlias("haiku", NATIVE)).toBe("claude-haiku-4-5");
  });

  it("answers nothing for a family the list does not carry", () => {
    expect(resolveAlias("opus", ["fable", "claude-fable-5-1"])).toBe(null);
  });
});

describe("newestAlias", () => {
  it("is the family the catalog lists first", () => {
    expect(newestAlias(NATIVE)).toBe("fable");
  });

  it("says nothing about a list with no claude id in it", () => {
    expect(newestAlias(["gpt-6"])).toBe(null);
    expect(newestAlias([])).toBe(null);
  });
});

describe("groupModels", () => {
  it("leads with the four aliases, named after the id each resolves to", () => {
    const { primary } = groupModels(NATIVE);
    expect(primary.map((row) => row.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(primary.map((row) => row.label)).toEqual([
      "Claude Fable 5.1",
      "Claude Opus 5",
      "Claude Sonnet 5",
      "Claude Haiku 4.5",
    ]);
  });

  // The noise this exists to remove: the alias and the id it resolves to used
  // to sit in the menu as two rows naming the same weights.
  it("folds every pinned id, and never the one an alias already names", () => {
    const { legacy } = groupModels(NATIVE);
    const ids = legacy.map((row) => row.id);
    expect(ids).not.toContain("claude-fable-5-1");
    expect(ids).not.toContain("claude-opus-5");
    expect(ids).toContain("claude-opus-4-5");
    expect(ids).toContain("claude-sonnet-4-0");
    expect(ids.length).toBe(10);
  });

  it("keeps every id in front when a driver declares no alias", () => {
    const groups = groupModels(["gpt-6", "gpt-5"]);
    expect(groups.primary.map((row) => row.id)).toEqual(["gpt-6", "gpt-5"]);
    expect(groups.legacy).toEqual([]);
  });
});

describe("isCurrentModel", () => {
  it("marks the alias row of a thread pinned to the id it resolves to", () => {
    const [fable] = groupModels(NATIVE).primary;
    expect(isCurrentModel(fable, "fable")).toBe(true);
    expect(isCurrentModel(fable, "claude-fable-5-1")).toBe(true);
    expect(isCurrentModel(fable, "claude-fable-5")).toBe(false);
    expect(isCurrentModel(fable, null)).toBe(false);
  });
});
