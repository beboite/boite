import type { ThemeId, ThemeMode } from "$lib/types";

export type ResolvedTheme = ThemeId;

/**
 * Which palette a preference means right now.
 *
 * Split out from the applier so the choice is testable without a document, the
 * same way `motion.ts` splits its durations from its gate.
 *
 * Only "system" asks the OS anything. A named theme is a named theme, including
 * the two acrylics: an OS switching to light must not pull the window out of
 * acrylic black, which is what following the scheme rather than the id would
 * do.
 */
export function resolveTheme(mode: ThemeMode, prefersLight: boolean): ResolvedTheme {
  if (mode !== "system") return mode;
  return prefersLight ? "light" : "dark";
}

/**
 * Applies the palette as a data attribute on <html>, so CSS gates on
 * `html[data-theme="acrylic-white"]` rather than on the media query directly:
 * the user's explicit choice has to win over the OS, and only "system" keeps
 * listening. Same shape as the motion gate next door, deliberately.
 *
 * `onApplied` exists for the three things CSS cannot repaint: the terminals
 * draw to a canvas from a palette they read once at construction, CodeMirror
 * needs its own dark flag handed over, and the OS backdrop is a window call
 * rather than a style. Returns a cleanup for the media-query listener.
 */
export function applyThemePreference(
  mode: ThemeMode,
  doc: Document = document,
  onApplied?: (theme: ResolvedTheme) => void,
): () => void {
  const query =
    doc.defaultView?.matchMedia("(prefers-color-scheme: light)") ?? null;
  // The first apply reports even when the attribute already says what it is
  // about to say. `boot-theme.js` sets it before the app has parsed a line of
  // Svelte, so on every start the interesting case is exactly the one an
  // equality check calls a no-op, and the acrylic material would be the thing
  // never asked for.
  let reported = false;
  const apply = () => {
    const resolved = resolveTheme(mode, query?.matches ?? false);
    const changed = doc.documentElement.dataset.theme !== resolved;
    if (changed) doc.documentElement.dataset.theme = resolved;
    if (!changed && reported) return;
    reported = true;
    onApplied?.(resolved);
  };
  apply();
  if (mode === "system" && query) {
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }
  return () => {};
}
