import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  availableFonts,
  clampTerminalScale,
  DEFAULT_MONO_STACK,
  DEFAULT_SANS_STACK,
  fontStack,
  TERMINAL_FONT_BASE,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  terminalFontSize,
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

/**
 * `document.fonts.check` cannot answer this question: it walks the faces CSS
 * connected, and this app ships no `@font-face`, so it used to say yes to every
 * name and the filter was inert in the shipping build. What is asserted here is
 * the measurement that replaced it, against a canvas that resolves a stack the
 * way a real one does.
 */
describe("probing what the machine has", () => {
  /** The generic defaults of the imaginary machine every case below runs on. */
  const GENERIC_WIDTHS: Record<string, number> = {
    monospace: 100,
    "sans-serif": 110,
    serif: 120,
  };

  /**
   * A canvas that measures whichever family in the stack the machine has, and
   * that ignores a `font` it cannot parse, which is what a real one does.
   */
  function canvas(
    widths: Record<string, number>,
    unparseable: readonly string[] = [],
  ): Document {
    const known = { ...GENERIC_WIDTHS, ...widths };
    let font = "";
    const ctx = {
      get font() {
        return font;
      },
      set font(spec: string) {
        if (!unparseable.some((bad) => spec.includes(bad))) font = spec;
      },
      measureText: () => {
        const families = font
          .replace(/^\S+\s+/, "")
          .split(",")
          .map((f) => f.trim().replace(/^"|"$/g, ""));
        const hit = families.find((f) => known[f] !== undefined);
        return { width: hit ? known[hit] : 0 };
      },
    };
    return {
      createElement: () => ({ getContext: () => ctx }),
    } as unknown as Document;
  }

  it("keeps the families that measure apart from the generics, in order", () => {
    const machine = canvas({ Hack: 90, Menlo: 95 });
    expect(availableFonts(["Hack", "Nope", "Menlo"], machine)).toEqual([
      "Hack",
      "Menlo",
    ]);
  });

  /**
   * A family the machine has falls through to the generic in every stack it is
   * put in front of, and so measures exactly like it. One generic would call
   * that missing, which is why three are tried.
   */
  it("keeps a family that is the machine's own default for one generic", () => {
    const windows = canvas({ Consolas: GENERIC_WIDTHS.monospace });
    expect(availableFonts(["Consolas"], windows)).toEqual(["Consolas"]);
  });

  it("drops a name the browser cannot parse into a font shorthand", () => {
    // `font` keeps its previous value on a bad spec, and the previous value is
    // the generic's own baseline, so the widths match and the name drops out.
    const machine = canvas({ "Bad Name": 90 }, ["Bad Name"]);
    expect(availableFonts(["Bad Name"], machine)).toEqual([]);
  });

  /**
   * Offering a font that turns out to fall back is a smaller failure than
   * offering an empty list, so a browser with no 2D canvas answers everything.
   */
  it("offers the whole list when it cannot measure", () => {
    const blind = {
      createElement: () => ({ getContext: () => null }),
    } as unknown as Document;
    expect(availableFonts(["Hack", "Menlo"], blind)).toEqual(["Hack", "Menlo"]);

    const bare = {} as unknown as Document;
    expect(availableFonts(["Hack", "Menlo"], bare)).toEqual(["Hack", "Menlo"]);
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

/**
 * The size the terminals are drawn at is also what the appearance preview
 * renders its sample in, and a preview that is not the size it previews has no
 * job left. Both call this, so the two cannot disagree.
 */
describe("the terminal font size", () => {
  it("is the base at 100% of both scales", () => {
    expect(terminalFontSize(100, 100)).toBe(TERMINAL_FONT_BASE);
  });

  it("multiplies the two scales rather than picking one", () => {
    expect(terminalFontSize(150, 200)).toBe(
      Math.min(TERMINAL_FONT_MAX, Math.round((13 * 150 * 200) / 10_000)),
    );
    // The UI scale alone moves it, which is what the preview used to miss.
    expect(terminalFontSize(150, 100)).not.toBe(terminalFontSize(100, 100));
  });

  it("stays inside the px range xterm is given", () => {
    expect(terminalFontSize(75, TERMINAL_SCALE_MIN, 0.25)).toBe(
      TERMINAL_FONT_MIN,
    );
    expect(terminalFontSize(150, TERMINAL_SCALE_MAX, 4)).toBe(TERMINAL_FONT_MAX);
  });

  it("rides pinch on top of both scales", () => {
    expect(terminalFontSize(100, 100, 2)).toBe(26);
  });
});
