import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SETTINGS_CATALOGUE, settingAnchorId } from "./catalogue";
import { EN_MESSAGES } from "$lib/i18n/messages";

const dir = fileURLToPath(new URL(".", import.meta.url));

const pages = new Map(
  readdirSync(dir)
    .filter((name) => /^Settings.*Tab\.svelte$/.test(name))
    .map((name) => [
      // SettingsTerminalTab.svelte -> terminal
      name.replace(/^Settings|Tab\.svelte$/g, "").toLowerCase(),
      readFileSync(`${dir}/${name}`, "utf8"),
    ]),
);

/**
 * The one way a settings search rots: a control moves page, or one is added
 * with no entry, and it becomes unfindable while everything still compiles and
 * every page still renders. Nothing at runtime notices a search index pointing
 * at an anchor no page draws.
 */
describe("the settings catalogue matches the pages", () => {
  it("names a page that exists", () => {
    for (const entry of SETTINGS_CATALOGUE) {
      expect(pages.has(entry.tab), entry.key).toBe(true);
    }
  });

  it("names a control that page actually anchors", () => {
    for (const entry of SETTINGS_CATALOGUE) {
      const source = pages.get(entry.tab) ?? "";
      expect(source.includes(`anchor="${entry.key}"`), entry.key).toBe(true);
    }
  });

  it("leaves no anchored control out of the catalogue", () => {
    const listed = new Set<string>(SETTINGS_CATALOGUE.map((e) => e.key));
    for (const [tab, source] of pages) {
      for (const m of source.matchAll(/anchor="([^"]+)"/g)) {
        expect(listed.has(m[1]), `${tab}: ${m[1]}`).toBe(true);
      }
    }
  });

  it("only names keys the dictionary has", () => {
    for (const entry of SETTINGS_CATALOGUE) {
      expect(EN_MESSAGES, entry.key).toHaveProperty(entry.key);
      if (entry.descKey) expect(EN_MESSAGES).toHaveProperty(entry.descKey);
    }
  });

  it("lists nothing twice", () => {
    const keys = SETTINGS_CATALOGUE.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("anchor ids", () => {
  it("are derived from the key, dots and all", () => {
    expect(settingAnchorId("appearance.uiScale")).toBe("setting-appearance-uiScale");
  });

  /** A dotted key inside `#id` would be a class selector, not an id. */
  it("carry no character a selector reads as something else", () => {
    for (const entry of SETTINGS_CATALOGUE) {
      expect(settingAnchorId(entry.key)).toMatch(/^[A-Za-z][\w-]*$/);
    }
  });
});
