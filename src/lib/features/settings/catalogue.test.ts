import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SETTINGS_CATALOGUE, settingAnchorId } from "./catalogue";
import { EN_MESSAGES } from "$lib/i18n/messages";

const dir = fileURLToPath(new URL(".", import.meta.url));

/**
 * A page's source, plus the sources of the sections it composes.
 *
 * A page used to be one file, and two of them are now several: "agents" is the
 * CLI list and the switcher cards, "machines" is sync and pairing. Those parts
 * are `*Section.svelte` rather than `Settings*Tab.svelte` precisely so this
 * walk can tell a page from a piece of one — a piece read as a page of its own
 * would draw every one of its anchors twice over.
 */
function sourceOf(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) return "";
  seen.add(name);
  const source = readFileSync(`${dir}/${name}`, "utf8");
  const sections = [...source.matchAll(/from "\.\/(\w+Section)\.svelte"/g)];
  return [source, ...sections.map((m) => sourceOf(`${m[1]}.svelte`, seen))].join("\n");
}

const pages = new Map(
  readdirSync(dir)
    .filter((name) => /^Settings.*Tab\.svelte$/.test(name))
    .map((name) => [
      // SettingsTerminalTab.svelte -> terminal
      name.replace(/^Settings|Tab\.svelte$/g, "").toLowerCase(),
      sourceOf(name),
    ]),
);

/**
 * The end of an element's opening tag, brace-aware.
 *
 * `<Tag[^>]*>` would do it if props were plain, but `onToggle={() => ...}` puts
 * a `>` inside every second one and the tag would look like it ended at the
 * arrow. Counting braces is the shortest thing that is actually right, and the
 * check below is worth nothing if it reads half a tag.
 */
function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote = "";
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    } else if (c === ">" && depth === 0) {
      return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

/**
 * The ways a settings search rots: a control moves page, or one is added with
 * no entry, and it becomes unfindable while everything still compiles and every
 * page still renders. Nothing at runtime notices a search index pointing at an
 * anchor no page draws, and nothing notices a control no anchor names.
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

  /**
   * Walking the anchors only ever proved anchored -> listed, never
   * control -> anchored, so a toggle added with no `anchor` at all passed every
   * test here while being unfindable. That is exactly how two of them shipped.
   * This is the check that starts from what a page draws.
   */
  it("anchors every control a page draws", () => {
    for (const [tab, source] of pages) {
      for (const m of source.matchAll(/<(SettingsCard|ToggleSetting)\b/g)) {
        const tag = openingTag(source, m.index ?? 0);
        const label = /label=\{t\("([^"]+)"\)\}|title=\{t\("([^"]+)"\)\}/.exec(tag);
        expect(tag.includes("anchor="), `${tab}: ${label?.[1] ?? label?.[2] ?? tag}`).toBe(
          true,
        );
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

  /**
   * "lists nothing twice" covers the array; this covers the DOM. Two pages
   * anchoring the same key draw the same id, `getElementById` answers with
   * whichever comes first, and one of the two results silently jumps to the
   * other's control.
   */
  it("are drawn once across every page", () => {
    const drawnBy = new Map<string, string>();
    for (const [tab, source] of pages) {
      for (const m of source.matchAll(/anchor="([^"]+)"/g)) {
        const id = settingAnchorId(m[1]);
        expect(drawnBy.has(id), `${id}: ${drawnBy.get(id)} and ${tab}`).toBe(false);
        drawnBy.set(id, tab);
      }
    }
  });
});
