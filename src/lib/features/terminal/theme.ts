import type { ITheme } from "@xterm/xterm";
import { liveTerminal, liveTerminalIds } from "$lib/shared/terminals";

// Builds the xterm theme from the CSS tokens in app.css so the terminal and
// the chrome can never drift apart. Fallbacks cover the first paint before
// stylesheets resolve (and tests without a DOM stylesheet).
function reader() {
  const style = getComputedStyle(document.documentElement);
  return (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
}

// xterm measures the cell on a canvas, so it wants a resolved stack rather than
// a var(): passing one leaves it measuring an invalid font. Read here for the
// same reason the palette is, because a copy of --font-mono's string in the
// component silently desynced the terminal every time app.css moved.
export function xtermFontFamily(): string {
  return reader()(
    "--font-mono",
    '"Geist Mono", "JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace',
  );
}

export function xtermTheme(): ITheme {
  const v = reader();

  const background = v("--color-background", "#0a0a0a");
  const foreground = v("--color-term-foreground", "#e4e4e7");
  return {
    background,
    foreground,
    cursor: v("--color-term-cursor", "#d4d4d8"),
    cursorAccent: background,
    // Shared with ::selection in app.css: selecting text in a pane and in the
    // chrome used to be two different highlights.
    selectionBackground: v("--color-selection", "rgba(228, 228, 231, 0.18)"),
    black: v("--color-term-black", "#18181b"),
    red: v("--color-term-red", "#f07178"),
    green: v("--color-term-green", "#c3e88d"),
    yellow: v("--color-term-yellow", "#ffcb6b"),
    blue: v("--color-term-blue", "#82aaff"),
    magenta: v("--color-term-magenta", "#c792ea"),
    cyan: v("--color-term-cyan", "#89ddff"),
    white: v("--color-term-white", "#e4e4e7"),
    brightBlack: v("--color-term-bright-black", "#52525b"),
    brightRed: v("--color-term-bright-red", "#ff8b92"),
    brightGreen: v("--color-term-bright-green", "#ddffa7"),
    brightYellow: v("--color-term-bright-yellow", "#ffe585"),
    brightBlue: v("--color-term-bright-blue", "#9cc4ff"),
    brightMagenta: v("--color-term-bright-magenta", "#e1acff"),
    brightCyan: v("--color-term-bright-cyan", "#a3f7ff"),
    brightWhite: v("--color-term-bright-white", "#fafafa"),
  };
}

/**
 * Re-reads the palette into every terminal on screen.
 *
 * A terminal takes its colours once, at construction, and paints them onto a
 * canvas: a palette swap that only moves CSS custom properties repaints the
 * whole app around a row of panes still drawn in the old one. Assigning
 * `options.theme` is what makes xterm rebuild its glyph atlas, so this is the
 * whole of the update: scrollback, selection and process are untouched.
 *
 * Read once and shared: `getComputedStyle` is the expensive half, and every
 * terminal is resolving the same twenty properties off the same root.
 */
export function repaintTerminals(): void {
  const theme = xtermTheme();
  for (const id of liveTerminalIds()) {
    const term = liveTerminal(id);
    if (term) term.options.theme = theme;
  }
}
