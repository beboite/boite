import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "./appearance";

const css = readFileSync(
  fileURLToPath(new URL("../../app.css", import.meta.url)),
  "utf8",
);

/**
 * Colours that are one value in every palette, and why.
 *
 * The icon tints are what the shortcut picker offers, and what it stores on a
 * shortcut row is the plain hex the user chose: a palette moving them would
 * repaint rows somebody picked by eye, in a colour they never saw.
 */
const THEME_INDEPENDENT = [
  "--color-icon-rust",
  "--color-icon-red",
  "--color-icon-amber",
  "--color-icon-yellow",
  "--color-icon-green",
  "--color-icon-teal",
  "--color-icon-blue",
  "--color-icon-indigo",
  "--color-icon-purple",
  "--color-icon-pink",
];

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`${selector} is not in app.css`);
  const open = css.indexOf("{", start);
  const end = css.indexOf("\n}", open);
  return css.slice(open, end);
}

function declared(source: string, prefix: string): string[] {
  return [...source.matchAll(new RegExp(`(${prefix}[a-z0-9-]+):`, "g"))]
    .map((m) => m[1])
    .filter((name, i, all) => all.indexOf(name) === i)
    .sort();
}

/**
 * The invariant the whole two-palette design rests on. Nothing at runtime can
 * notice a role that exists in one palette and not the other: the app simply
 * draws that one thing in the dark value, which on a light background is
 * anything from a slightly-off grey to black text on black. It is asserted
 * here because the failure is silent everywhere else.
 */
describe("the light palette covers the dark one", () => {
  const dark = declared(block("@theme"), "--color-");
  const light = declared(block(':root[data-theme="light"]'), "--color-");

  it("restates every colour role", () => {
    const missing = dark.filter(
      (name) => !light.includes(name) && !THEME_INDEPENDENT.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it("adds no role the dark palette does not have", () => {
    expect(light.filter((name) => !dark.includes(name))).toEqual([]);
  });

  it("leaves the picker's tints alone", () => {
    for (const name of THEME_INDEPENDENT) {
      expect(dark, name).toContain(name);
      expect(light, name).not.toContain(name);
    }
  });

  it("restates the elevation ramp, whose light edge is dark-only", () => {
    const ramp = declared(block("@theme"), "--shadow-e");
    expect(ramp.length).toBeGreaterThan(0);
    const lit = declared(block(':root[data-theme="light"]'), "--shadow-e");
    expect(lit).toEqual(ramp);
  });

  it("switches what native widgets are told the app is", () => {
    expect(block(":root")).toContain("--app-color-scheme: dark");
    expect(block(':root[data-theme="light"]')).toContain(
      "--app-color-scheme: light",
    );
  });
});

describe("resolving a theme preference", () => {
  it("takes an explicit choice whatever the OS says", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("follows the OS only on system", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  /**
   * The query asked is `prefers-color-scheme: light`, not dark: a browser that
   * answers neither leaves both matching `false`, and dark is what this app has
   * always been.
   */
  it("falls back to dark when nothing is preferred", () => {
    expect(resolveTheme("system", false)).toBe("dark");
  });
});
