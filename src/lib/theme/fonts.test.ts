import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  availableFonts,
  clampTerminalScale,
  DEFAULT_MONO_STACK,
  DEFAULT_SANS_STACK,
  fontStack,
  TERMINAL_SCALE_MAX,
  TERMINAL_SCALE_MIN,
} from "./fonts";

const css = readFileSync(
  fileURLToPath(new URL("../../app.css", import.meta.url)),
  "utf8",
);

function cssVar(name: string): string {
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`${name} is not declared in app.css`);
  return m[1].trim().replace(/\s+/g, " ");
}

/**
 * The stacks exist in two places on purpose: CSS needs one for everything it
 * draws, and the terminals need the same one as a resolved string, because a
 * canvas measures a font rather than inheriting it. Nothing at runtime can
 * notice the two drifting — the chrome would simply be set in one face and the
 * terminals in another — so it is asserted here.
 */
describe("the font stacks match app.css", () => {
  it("pairs the sans stack", () => {
    expect(cssVar("--font-sans")).toBe(DEFAULT_SANS_STACK);
  });

  it("pairs the mono stack", () => {
    expect(cssVar("--font-mono")).toBe(DEFAULT_MONO_STACK);
  });
});

describe("building a stack around a chosen family", () => {
  it("is the shipped stack when nothing is chosen", () => {
    expect(fontStack(null, DEFAULT_MONO_STACK)).toBe(DEFAULT_MONO_STACK);
    expect(fontStack("", DEFAULT_MONO_STACK)).toBe(DEFAULT_MONO_STACK);
    expect(fontStack("   ", DEFAULT_MONO_STACK)).toBe(DEFAULT_MONO_STACK);
  });

  /**
   * The fallbacks stay behind the choice rather than being replaced by it: a
   * face that covers Latin and nothing else still gets the app's own stack for
   * every glyph it does not have.
   */
  it("puts the choice in front of the shipped stack", () => {
    expect(fontStack("Iosevka", DEFAULT_MONO_STACK)).toBe(
      `"Iosevka", ${DEFAULT_MONO_STACK}`,
    );
  });

  it("quotes the family, whatever it is called", () => {
    // Unquoted, a family named after a CSS keyword parses as the keyword and
    // the whole declaration is dropped.
    expect(fontStack("monospace", "serif")).toBe('"monospace", serif');
    expect(fontStack("Fira Code", "serif")).toBe('"Fira Code", serif');
  });

  it("cannot be made to close its own quote", () => {
    const built = fontStack('X"; color: red', "serif");
    expect(built).toBe('"X; color: red", serif');
  });
});

describe("probing what the machine has", () => {
  const doc = (answer: (family: string) => boolean) =>
    ({ fonts: { check: (spec: string) => answer(spec) } }) as unknown as Document;

  it("keeps the ones the browser confirms, in the order given", () => {
    const has = doc((spec) => spec.includes("Hack") || spec.includes("Menlo"));
    expect(availableFonts(["Hack", "Nope", "Menlo"], has)).toEqual([
      "Hack",
      "Menlo",
    ]);
  });

  /**
   * Offering a font that turns out to fall back is a smaller failure than
   * offering an empty list, so a browser with no font API answers everything.
   */
  it("offers the whole list when it cannot be asked", () => {
    const blind = {} as unknown as Document;
    expect(availableFonts(["Hack", "Menlo"], blind)).toEqual(["Hack", "Menlo"]);
  });

  it("drops a family the browser throws on", () => {
    const angry = {
      fonts: {
        check: () => {
          throw new Error("bad font spec");
        },
      },
    } as unknown as Document;
    expect(availableFonts(["Hack"], angry)).toEqual([]);
  });
});

describe("the terminal scale", () => {
  it("stays inside its range", () => {
    expect(clampTerminalScale(10)).toBe(TERMINAL_SCALE_MIN);
    expect(clampTerminalScale(1000)).toBe(TERMINAL_SCALE_MAX);
    expect(clampTerminalScale(120)).toBe(120);
  });

  it("falls back to 100 on a value that is not a number", () => {
    expect(clampTerminalScale(Number.NaN)).toBe(100);
    expect(clampTerminalScale(Number.POSITIVE_INFINITY)).toBe(100);
  });
});
