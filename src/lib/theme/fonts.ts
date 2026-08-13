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
 * The candidates this machine can actually draw, in the order given.
 *
 * `document.fonts.check` answers for system faces as well as loaded ones,
 * which is what makes this possible at all: a webview cannot enumerate
 * installed fonts, it can only be asked about a name it is given. A browser
 * with no font API answers the whole list, because offering a font that turns
 * out to fall back is a smaller failure than offering nothing.
 */
export function availableFonts(
  candidates: readonly string[],
  doc: Document = document,
): string[] {
  const fonts = doc.fonts;
  if (!fonts?.check) return [...candidates];
  return candidates.filter((family) => {
    try {
      return fonts.check(`12px "${family}"`);
    } catch {
      return false;
    }
  });
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
