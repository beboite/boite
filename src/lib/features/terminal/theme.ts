import type { ITheme } from "@xterm/xterm";

// Builds the xterm theme from the CSS tokens in app.css so the terminal and
// the chrome can never drift apart. Fallbacks cover the first paint before
// stylesheets resolve (and tests without a DOM stylesheet).
export function xtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;

  const background = v("--color-background", "#0a0a0a");
  const foreground = v("--color-term-foreground", "#e4e4e7");
  return {
    background,
    foreground,
    cursor: v("--color-term-cursor", "#d4d4d8"),
    cursorAccent: background,
    selectionBackground: "rgba(228, 228, 231, 0.18)",
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
