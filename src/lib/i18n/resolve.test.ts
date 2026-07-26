import { afterEach, describe, expect, it, vi } from "vitest";
import { EN_MESSAGES } from "./messages";
import { FR_MESSAGES } from "./messages.fr";
import { detectLocale, format, isLocale, isLocaleSetting, lookup } from "./resolve";

describe("format", () => {
  it("substitutes named slots", () => {
    expect(format("{count} of {total}", { count: 2, total: 9 })).toBe("2 of 9");
  });

  it("inserts $-bearing values literally", () => {
    // String.replace reads $&, $1 and $` in the replacement as capture syntax.
    // A branch or folder name can legally contain any of them.
    expect(format("Push to {branch}", { branch: "feat/$&-fix" })).toBe("Push to feat/$&-fix");
    expect(format("Delete {path}", { path: "src/$1.ts" })).toBe("Delete src/$1.ts");
  });

  it("leaves a slot alone when no value is supplied", () => {
    expect(format("{a}/{b}", { a: "x" })).toBe("x/{b}");
  });

  it("returns the template untouched with no params", () => {
    expect(format("{a}")).toBe("{a}");
  });
});

describe("lookup", () => {
  it("prefers the active dictionary", () => {
    expect(lookup(FR_MESSAGES, "common.settings")).toBe(FR_MESSAGES["common.settings"]);
  });

  it("falls back to English when the locale lacks the key", () => {
    const holey = { ...FR_MESSAGES, "common.settings": undefined } as unknown as typeof FR_MESSAGES;
    expect(lookup(holey, "common.settings")).toBe(EN_MESSAGES["common.settings"]);
  });

  it("falls back to English when no dictionary is loaded", () => {
    expect(lookup(undefined, "common.reset")).toBe(EN_MESSAGES["common.reset"]);
  });
});

describe("locale guards", () => {
  it("accepts the shipped locales only", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("accepts system on top of those for the stored setting", () => {
    expect(isLocaleSetting("system")).toBe(true);
    expect(isLocaleSetting("fr")).toBe(true);
    expect(isLocaleSetting("es")).toBe(false);
  });
});

describe("detectLocale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function withNavigator(languages: string[], language = languages[0]) {
    vi.stubGlobal("navigator", { languages, language });
  }

  it("defaults to English with no navigator at all", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectLocale()).toBe("en");
  });

  it("tolerates a navigator with no languages array", () => {
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(detectLocale()).toBe("fr");
  });

  it("matches a regional tag on its base subtag", () => {
    withNavigator(["fr-CA"]);
    expect(detectLocale()).toBe("fr");
  });

  it("walks the preference list past locales it does not ship", () => {
    withNavigator(["de-DE", "es", "fr-FR"]);
    expect(detectLocale()).toBe("fr");
  });

  it("falls back to English when nothing matches", () => {
    withNavigator(["de-DE", "ja"]);
    expect(detectLocale()).toBe("en");
  });
});

describe("dictionaries", () => {
  it("translate every English key", () => {
    const missing = Object.keys(EN_MESSAGES).filter(
      (key) => !(key in FR_MESSAGES) || !FR_MESSAGES[key as keyof typeof FR_MESSAGES],
    );
    expect(missing).toEqual([]);
  });

  it("carry the same interpolation slots on both sides", () => {
    const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(EN_MESSAGES) as (keyof typeof EN_MESSAGES)[]) {
      expect(slots(FR_MESSAGES[key]), key).toEqual(slots(EN_MESSAGES[key]));
    }
  });
});
