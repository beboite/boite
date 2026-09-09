/*
 * The theme setting: system, dark, light, or grain while the `theme-grain`
 * experiment is on. Dark is the palette on `:root`, so it stamps nothing; the
 * others stamp `data-theme` and `app.css` swaps the tokens or paints the
 * ground. The inline script in `index.html` runs the same rule before the
 * stylesheet arrives, so a reload never flashes the wrong ground; this module
 * owns it from the mount on.
 */

import { isExperimentEnabled, subscribeExperiments } from './experiments';

export type Theme = 'system' | 'dark' | 'light' | 'grain';

/** What a setting means once `system` has asked the OS. */
export type ResolvedTheme = 'dark' | 'light' | 'grain';

export const THEME_STORAGE_KEY = 'boite.theme';

const THEMES: Theme[] = ['system', 'dark', 'light', 'grain'];

/** What `<meta name="theme-color">` reads once the theme resolves: `--color-background`, or grain's mid tone. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: '#101013',
  light: '#f3f3f6',
  grain: '#1a1a1e'
};

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * The stored theme, `system` when nothing is stored, when storage is refused,
 * or when the stored id is one this build does not offer. Grain is one of those
 * until its experiment is on: turning the experiment off puts a grain window
 * back on the system theme without touching what is stored, so turning it back
 * on returns the choice the user had made.
 */
export function readTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === null || !THEMES.includes(raw as Theme)) return 'system';
    if (raw === 'grain' && !isExperimentEnabled('theme-grain')) return 'system';
    return raw as Theme;
  } catch {
    return 'system';
  }
}

export function writeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/** What the setting means right now: `system` asks the OS, the others answer for themselves. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  return typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

/** Stamps the root and the theme colour. Dark removes the attribute rather than setting one. */
export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  if (resolved === 'dark') delete root.dataset.theme;
  else root.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
}

/** Stores the choice and paints it in one call: what the settings control uses. */
export function setTheme(theme: Theme): void {
  writeTheme(theme);
  applyTheme(theme);
}

/**
 * Applies the stored theme, follows `prefers-color-scheme` while the setting
 * reads `system`, and repaints when an experiment is switched, since grain
 * exists only while `theme-grain` is on. Returns the function that drops both
 * listeners.
 */
export function startTheme(): () => void {
  applyTheme(readTheme());
  const stopExperiments = subscribeExperiments(() => applyTheme(readTheme()));
  if (typeof window.matchMedia !== 'function') return stopExperiments;
  const query = window.matchMedia(LIGHT_QUERY);
  const onchange = () => {
    if (readTheme() === 'system') applyTheme('system');
  };
  query.addEventListener('change', onchange);
  return () => {
    stopExperiments();
    query.removeEventListener('change', onchange);
  };
}
