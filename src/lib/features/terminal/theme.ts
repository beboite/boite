import type { ITheme } from "@xterm/xterm";
import { liveTerminal, liveTerminalIds } from "$lib/shared/terminals";
import { DEFAULT_MONO_STACK, fontStack } from "$lib/theme/fonts";
import { isThemeId, themeById } from "$lib/theme/themes";

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * Rewrites a CSS colour into the one notation xterm is sure to accept.
 *
 * xterm parses its theme itself, and it knows the four hex forms plus the
 * comma `rgb()`; anything else goes through a canvas that throws outright once
 * the alpha is not 255. app.css writes the acrylic palettes as
 * `rgb(6 6 8 / 0.44)`, so every colour in the theme was rejected together and
 * the pane fell back to xterm's own black-on-white default. That is the opaque
 * black background under white text, not a compositing failure.
 *
 * The canvas is the parser: assigning any colour the engine understands and
 * reading the property back returns `#rrggbb` or a comma `rgba()`, which is
 * exact where sampling a pixel would round the channels.
 */
function toXtermColor(value: string, fallback: string): string {
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d");
  if (!probe) return value;

  // An unparseable assignment is ignored rather than reported, so the previous
  // value is the only signal that one was refused.
  const sentinel = "#010203";
  probe.fillStyle = sentinel;
  probe.fillStyle = value;
  const css = probe.fillStyle;
  if (typeof css !== "string") return fallback;
  if (css === sentinel && value.toLowerCase() !== sentinel) return fallback;
  if (css.startsWith("#")) return css;

  const parts = css.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
  if (!parts) return fallback;
  const byte = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  const alpha = parts[4] === undefined ? 1 : Number(parts[4]);
  return `#${byte(Number(parts[1]))}${byte(Number(parts[2]))}${byte(Number(parts[3]))}${byte(alpha * 255)}`;
}

// Builds the xterm theme from the CSS tokens in app.css so the terminal and
// the chrome can never drift apart. Fallbacks cover the first paint before
// stylesheets resolve (and tests without a DOM stylesheet).
function reader() {
  const style = getComputedStyle(document.documentElement);
  return (name: string, fallback: string) => {
    // Custom properties come back as written, so this is app.css's own
    // notation rather than anything the engine has resolved.
    const raw = style.getPropertyValue(name).trim();
    return raw ? toXtermColor(raw, fallback) : fallback;
  };
}

/**
 * The stack the terminal measures its cell in.
 *
 * xterm wants a resolved stack rather than a `var()`: passing one leaves it
 * measuring an invalid font. Built rather than read back off the root, because
 * the root property is written by the same settings effect that would be racing
 * this call, and a terminal that measured its cell one frame early keeps the
 * wrong cell until something refits it.
 *
 * `DEFAULT_MONO_STACK` is app.css's own `--font-mono`, and `fonts.test.ts`
 * fails if the two ever stop being the same string.
 */
export function xtermFontFamily(family: string | null = null): string {
  return fontStack(family, DEFAULT_MONO_STACK);
}

/**
 * Whether the palette on screen is one the compositor blurs behind the window.
 *
 * Read off the attribute rather than from `currentTheme`, so this stays a plain
 * module and answers the same question `app.css` is answering one line away.
 */
function acrylicOnScreen(): boolean {
  const id = document.documentElement.dataset.theme;
  return isThemeId(id) && Boolean(themeById(id).acrylic);
}

/**
 * The option that lets a background alpha mean anything.
 *
 * Off, xterm composites every cell against an opaque background and the alpha
 * is dropped on the floor. On, it costs: the renderer can no longer assume what
 * is behind a glyph, which is why this follows the palette rather than being
 * left true.
 */
export function xtermAllowTransparency(): boolean {
  return acrylicOnScreen();
}

export function xtermTheme(): ITheme {
  const v = reader();

  // The palette's own value, alpha included: the acrylic blocks carry the same
  // tint the chrome wears, so a pane is one more translucent surface over the
  // blurred desktop rather than a hole in the window.
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
  const allowTransparency = xtermAllowTransparency();
  for (const id of liveTerminalIds()) {
    const term = liveTerminal(id);
    if (!term) continue;
    // Before the theme, not after: the flag decides how the atlas the next line
    // rebuilds is composited, and setting it second rebuilds it twice.
    term.options.allowTransparency = allowTransparency;
    term.options.theme = theme;
    // The theme assignment rebuilds the atlas; this is what puts the rebuilt
    // glyphs on screen for rows nothing is about to write to. A pane sitting on
    // a finished agent redraws on its own otherwise only when it next scrolls.
    term.refresh(0, term.rows - 1);
  }
}
