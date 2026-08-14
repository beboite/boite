/**
 * Which typeface each surface is drawn in.
 *
 * Two families reach the screen: the sans the chrome is set in, and the mono
 * the terminals and the editor share. Both were written into `app.css` as one
 * stack apiece, so the answer to "this font renders badly on my machine" was
 * to edit the app.
 *
 * A choice is stored as one family name, never as a stack, and the stack is
 * rebuilt around it here. Storing the whole stack would freeze today's
 * fallbacks into a settings row: a machine that later loses the chosen font
 * would fall through to whatever the app shipped the day the row was written,
 * rather than to what it ships now.
 */

/** What the app falls back to, and what `null` means. Mirrors app.css. */
export const DEFAULT_SANS_STACK =
  '"Geist", "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const DEFAULT_MONO_STACK =
  '"Geist Mono", "JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace';

/**
 * The families offered, if the machine has them.
 *
 * Deliberately short and boring. A full enumeration of installed fonts is not
 * reachable from a webview without a permission prompt, and a list of two
 * hundred names is not a choice anybody makes: these are the faces people
 * actually set a terminal in, plus whatever the platform ships.
 */
export const MONO_CANDIDATES = [
  "Geist Mono",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
  "IBM Plex Mono",
  "Source Code Pro",
  "Hack",
  "Iosevka",
  "MonoLisa",
  "Menlo",
  "Monaco",
  "SF Mono",
  "Consolas",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Courier New",
] as const;

export const SANS_CANDIDATES = [
  "Geist",
  "Inter",
  "IBM Plex Sans",
  "Source Sans 3",
  "Segoe UI",
  "SF Pro Text",
  "Helvetica Neue",
  "Roboto",
  "Ubuntu",
  "Noto Sans",
  "Arial",
] as const;

/**
 * A stack with the chosen family in front of the shipped one.
 *
 * The default stack stays behind the choice rather than being replaced by it,
 * so a family that covers Latin and nothing else still gets the app's own
 * fallbacks for everything it has no glyph for. `null` is the default itself.
 */
export function fontStack(family: string | null, fallback: string): string {
  const name = family?.trim();
  if (!name) return fallback;
  // Quoted whatever it is: a family whose name is a CSS keyword (`monospace`,
  // `inherit`) or carries a space parses as something else unquoted.
  return `"${name.replace(/["\\]/g, "")}", ${fallback}`;
}

/**
 * A string whose width says which face drew it.
 *
 * Latin letters, digits and ASCII punctuation only: a glyph the candidate has
 * no coverage for is drawn by the fallback in both measurements, which would
 * hide the very difference this is looking for. Repeated because a fraction of
 * a pixel per glyph only adds up to a readable difference over a long run.
 */
const PROBE = "mmmmmmmmmmlliWWWWWW0O1@#%iIl1|oO";

/** Large enough that two faces one hinting step apart still measure apart. */
const PROBE_SIZE = "72px";

/**
 * The generics a candidate is measured against.
 *
 * Three, not one, because a family that IS the machine's own default for a
 * generic (Consolas for `monospace` on Windows, Arial for `sans-serif`)
 * measures identically against that one and differently against the others.
 */
const GENERICS = ["monospace", "sans-serif", "serif"] as const;

function probeContext(doc: Document): CanvasRenderingContext2D | null {
  try {
    return doc.createElement?.("canvas")?.getContext?.("2d") ?? null;
  } catch {
    return null;
  }
}

/**
 * The candidates this machine can actually draw, in the order given.
 *
 * A webview cannot enumerate installed fonts, and `document.fonts.check` does
 * not answer the question either: Blink walks the `FontFaceCache`, which only
 * holds CSS-connected faces, so an app shipping no `@font-face` gets `true` for
 * every name it asks about and the list comes back unfiltered. That filter read
 * like detection and was inert, which is worse than none: a Windows box was
 * offered `SF Mono` and `Menlo`, and picking one silently fell back.
 *
 * So the faces are measured instead. A probe is drawn in a generic family, then
 * in the candidate with that same generic behind it: a family the machine does
 * not have falls through to the generic and measures to the pixel identically,
 * one it does have essentially never does. A machine with no 2D canvas is
 * offered the whole list, because a font that turns out to fall back is a
 * smaller failure than an empty menu.
 */
export function availableFonts(
  candidates: readonly string[],
  doc: Document = document,
): string[] {
  const ctx = probeContext(doc);
  if (!ctx?.measureText) return [...candidates];
  return candidates.filter((family) =>
    GENERICS.some((generic) => {
      ctx.font = `${PROBE_SIZE} ${generic}`;
      const fallback = ctx.measureText(PROBE).width;
      // The generic is measured again right before each candidate rather than
      // once up front, because a spec the browser cannot parse leaves `font`
      // untouched: on this ordering that leftover value is the generic itself,
      // so a name that breaks the shorthand measures equal and drops out on its
      // own instead of being read as a difference.
      ctx.font = `${PROBE_SIZE} ${fontStack(family, generic)}`;
      return ctx.measureText(PROBE).width !== fallback;
    }),
  );
}

/**
 * How much bigger the terminals are than the rest of the app.
 *
 * The UI scale already reaches the terminals: it is a percentage on the root
 * font size, and the terminal font size is computed from it because a canvas
 * cannot inherit a rem. This rides on top of that, so an agent's output can be
 * made readable without every box in the window growing with it, which is the
 * one thing the zoom slider cannot do.
 */
export const TERMINAL_SCALE_MIN = 60;
export const TERMINAL_SCALE_MAX = 200;

export function clampTerminalScale(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(
    TERMINAL_SCALE_MAX,
    Math.max(TERMINAL_SCALE_MIN, Math.round(percent)),
  );
}

/** What 100% zoom at 100% terminal scale means, in px. */
export const TERMINAL_FONT_BASE = 13;
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;

/**
 * The px a terminal is actually drawn at.
 *
 * Lives here rather than in Terminal.svelte because the appearance preview has
 * to be able to say the same number, and the copy it started with dropped the
 * UI scale: the sample was the size the terminal would be at 100% zoom and no
 * other, which is the one thing a preview may not get wrong.
 *
 * Two percentages divide by 10 000. The UI scale reaches the chrome as a root
 * font-size, which a canvas-drawn terminal cannot inherit, so it is multiplied
 * in here instead: the zoom slider used to grow every box around a terminal and
 * leave the text inside it exactly where it was. Pinch rides on top of both, so
 * a pinched pane still follows a later move of either slider.
 */
export function terminalFontSize(
  uiScalePercent: number,
  terminalScalePercent: number,
  pinchFactor = 1,
): number {
  return Math.max(
    TERMINAL_FONT_MIN,
    Math.min(
      TERMINAL_FONT_MAX,
      Math.round(
        (TERMINAL_FONT_BASE *
          uiScalePercent *
          terminalScalePercent *
          pinchFactor) /
          10_000,
      ),
    ),
  );
}
