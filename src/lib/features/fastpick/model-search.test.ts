import { describe, expect, it } from "vitest";
import { filterModels, matchesQuery } from "./model-search";

const nameOf = (m: { id: string; label: string | null }) => m.label ?? m.id;

const catalogue = [
  { id: "acme-opus-5", label: "Opus 5" },
  { id: "acme-sonnet-5", label: "Sonnet 5" },
  { id: "acme-gpt-5-6-terra", label: "GPT-5.6 Terra" },
];

describe("matchesQuery", () => {
  it("finds a model by its label", () => {
    expect(matchesQuery("Opus 5", "acme-opus-5", "opus")).toBe(true);
  });

  it("finds a model by its id, which is the half the label never shows", () => {
    expect(matchesQuery("House model", "gw-qwopus", "qwopus")).toBe(true);
  });

  it("ignores the separators, so a name is found without guessing where they fall", () => {
    expect(matchesQuery("GPT-5.6 Terra", "acme-gpt-5-6-terra", "gpt56")).toBe(true);
  });

  it("takes the tokens in any order", () => {
    expect(matchesQuery("Opus 5", "acme-opus-5", "5 opus")).toBe(true);
  });

  it("says no rather than everything when nothing carries the letters", () => {
    expect(matchesQuery("Opus 5", "acme-opus-5", "kimi")).toBe(false);
  });

  it("matches everything on an empty query", () => {
    expect(matchesQuery("Opus 5", "acme-opus-5", "   ")).toBe(true);
  });
});

describe("filterModels", () => {
  it("narrows letter by letter", () => {
    expect(filterModels(catalogue, "s", nameOf).map((m) => m.id)).toEqual([
      "acme-opus-5",
      "acme-sonnet-5",
    ]);
    expect(filterModels(catalogue, "so", nameOf).map((m) => m.id)).toEqual(["acme-sonnet-5"]);
    expect(filterModels(catalogue, "sox", nameOf)).toEqual([]);
  });

  it("hands back the list itself when nothing is typed", () => {
    expect(filterModels(catalogue, "", nameOf)).toBe(catalogue);
  });
});
