import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "./appearance";
import { THEMES, colorSchemeOf, isThemeId } from "./themes";

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
 * The invariant the whole multi-palette design rests on. Nothing at runtime can
 * notice a role that exists in one palette and not the other: the app simply
 * draws that one thing in the dark value, which on a light background is
 * anything from a slightly-off grey to black text on black. It is asserted
 * here because the failure is silent everywhere else.
 *
 * Only the schemes have to be exhaustive, not the palettes. A dark theme that
 * inherits the dark ramp inherits values that were picked for it, which is why
 * midnight and acrylic black restate their neutrals and nothing else. Flipping
 * the scheme is the case where inheriting is always a bug.
 */
describe("the light palette covers the dark one", () => {
  const dark = declared(block("@theme"), "--color-");
  const light = declared(block('[data-theme="light"]'), "--color-");

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
    const lit = declared(block('[data-theme="light"]'), "--shadow-e");
    expect(lit).toEqual(ramp);
  });

  it("switches what native widgets are told the app is", () => {
    expect(block(":root")).toContain("--app-color-scheme: dark");
    expect(block('[data-theme="light"]')).toContain("--app-color-scheme: light");
  });
});

/**
 * The registry and the stylesheet are two halves of one list, and neither can
 * see the other. A theme offered in the picker with no block behind it is a
 * swatch that paints the dark palette and a setting that does nothing.
 */
describe("every theme in the registry is a palette in app.css", () => {
  it.each(THEMES.map((theme) => theme.id))("%s has a block", (id) => {
    expect(css).toContain(`[data-theme="${id}"]`);
  });

  /**
   * Selectors are attribute-only rather than `:root[…]`: the settings swatches
   * paint themselves by carrying the attribute on a nested element, which is
   * what keeps the previews from being a second copy of the palettes.
   */
  it("scopes no palette to the root element", () => {
    expect(css).not.toContain(':root[data-theme="');
  });

  /**
   * A palette states all of its roles somewhere in its own chain, so what a
   * theme paints never depends on which theme happens to be around it. In
   * practice that means every id sits on its scheme's base block and overrides
   * from there, and the swatch previews are what makes it load-bearing: they
   * are the one place a theme is drawn inside a document set to another one.
   */
  it.each(THEMES.map((theme) => [theme.id, theme.colorScheme] as const))(
    "%s sits on the %s base block",
    (id, scheme) => {
      const base = scheme === "light" ? '[data-theme="light"]' : '[data-theme="dark"]';
      const start = css.indexOf(base);
      const selectors = css.slice(start, css.indexOf("{", start));
      expect(selectors).toContain(`[data-theme="${id}"]`);
    },
  );

  /**
   * The dark block is `@theme` written twice, because `@theme` only reaches an
   * element by inheritance and a swatch has to override what it inherits. The
   * duplication is only safe while it is exact.
   */
  it("keeps the dark block identical to the values @theme declares", () => {
    // Comments out first: the ramp's prose quotes `--lit: 0.4`, and a value
    // regex reading a comment swallows the declaration behind it.
    const flat = (source: string): [string, string][] =>
      [
        ...source
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g),
      ].map(([, name, value]) => [name, value.replace(/\s+/g, " ").trim()]);
    const theme = new Map(flat(block("@theme")));
    for (const [name, value] of flat(block('[data-theme="dark"]'))) {
      if (name === "--app-color-scheme") continue;
      expect(theme.get(name), name).toBe(value);
    }
  });
});

describe("resolving a theme preference", () => {
  it("takes an explicit choice whatever the OS says", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  /**
   * The acrylics in particular. They are a scheme plus a material, so an OS
   * that flips to light must not pull the window out of acrylic black: only
   * "system" is asking the OS anything.
   */
  it("keeps a named theme when the OS disagrees with its scheme", () => {
    expect(resolveTheme("acrylic-black", true)).toBe("acrylic-black");
    expect(resolveTheme("acrylic-white", false)).toBe("acrylic-white");
    expect(resolveTheme("midnight", true)).toBe("midnight");
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

describe("the registry", () => {
  it("rejects what is not a theme, including the mode that is not one", () => {
    expect(isThemeId("system")).toBe(false);
    expect(isThemeId("glass-dark")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId("acrylic-white")).toBe(true);
  });

  it("answers a scheme for every theme", () => {
    for (const theme of THEMES) {
      expect(colorSchemeOf(theme.id)).toBe(theme.colorScheme);
    }
  });

  it("has an acrylic on each side, which is what the pair is for", () => {
    const acrylics = THEMES.filter((theme) => theme.acrylic);
    expect(acrylics.map((theme) => theme.colorScheme).sort()).toEqual([
      "dark",
      "light",
    ]);
  });
});
