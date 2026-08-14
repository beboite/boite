import type { ThemeMode } from "$lib/types";

export type ResolvedTheme = "dark" | "light";

/**
 * Which palette a preference means right now.
 *
 * Split out from the applier so the three-way choice is testable without a
 * document, the same way `motion.ts` splits its durations from its gate.
 */
export function resolveTheme(mode: ThemeMode, prefersLight: boolean): ResolvedTheme {
  if (mode === "dark" || mode === "light") return mode;
  return prefersLight ? "light" : "dark";
}

/**
 * Applies the palette as a data attribute on <html>, so CSS gates on
 * `html[data-theme="light"]` rather than on the media query directly: the
 * user's explicit choice has to win over the OS, and only "system" keeps
 * listening. Same shape as the motion gate next door, deliberately.
 *
 * `onApplied` exists for the one thing CSS cannot repaint: the terminals draw
 * to a canvas from a palette they read once at construction, so they are told
 * rather than restyled. Returns a cleanup for the media-query listener.
 */
export function applyThemePreference(
  mode: ThemeMode,
  doc: Document = document,
  onApplied?: (theme: ResolvedTheme) => void,
): () => void {
  const query =
    doc.defaultView?.matchMedia("(prefers-color-scheme: light)") ?? null;
  const apply = () => {
    const resolved = resolveTheme(mode, query?.matches ?? false);
    if (doc.documentElement.dataset.theme === resolved) return;
    doc.documentElement.dataset.theme = resolved;
    onApplied?.(resolved);
  };
  apply();
  if (mode === "system" && query) {
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }
  return () => {};
}
