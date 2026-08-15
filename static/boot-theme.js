// Paints the palette before the app exists.
//
// Blocking, in <head>, and external rather than inline because the CSP only
// trusts 'self' for scripts. Everything it needs is synchronous: the theme
// preference is a device field, so it is in localStorage rather than behind the
// SQLite round-trip the settings store does, and reading it here is what stops
// a window opening dark and turning light a few hundred milliseconds later.
//
// The one duplicated piece of knowledge in the theming stack: the storage key
// and the "system" fallback are also in lib/features/settings/store.svelte.ts
// and lib/theme/appearance.ts. Nothing bundled can be reached from here, and
// disagreeing with them costs a flash, not a bug: the app applies the real
// answer on its first effect either way.
(() => {
  const THEMES = ["dark", "light", "midnight", "acrylic-black", "acrylic-white"];

  let mode = "system";
  try {
    const raw = localStorage.getItem("boite.layout");
    if (raw) {
      const stored = JSON.parse(raw);
      if (typeof stored?.themeMode === "string") mode = stored.themeMode;
    }
  } catch {
    // Private mode, or a blob written by a version that did not have themes.
  }

  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  const theme = THEMES.includes(mode) ? mode : prefersLight ? "light" : "dark";

  // The attribute and nothing else. Writing `style.colorScheme` here would win
  // over `html { color-scheme: var(--app-color-scheme) }` forever, because an
  // inline style beats a stylesheet, and every later theme swap would leave the
  // native widgets on whatever this boot happened to pick.
  document.documentElement.dataset.theme = theme;
})();
