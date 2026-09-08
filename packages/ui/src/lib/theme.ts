/*
 * The theme setting: system, dark or light. Dark is the palette on `:root`, so
 * it stamps nothing; light stamps `data-theme="light"` and `app.css` swaps the
 * tokens. The inline script in `index.html` runs the same rule before the
 * stylesheet arrives, so a reload never flashes the wrong ground; this module
 * owns it from the mount on.
 */

export type Theme = 'system' | 'dark' | 'light';

export const THEME_STORAGE_KEY = 'boite.theme';

const THEMES: Theme[] = ['system', 'dark', 'light'];

/** What `<meta name="theme-color">` reads once the theme resolves. */
const THEME_COLOR: Record<'dark' | 'light', string> = { dark: '#0a0a0a', light: '#fbfbfc' };

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The stored theme, `system` when nothing is stored or storage is refused. */
export function readTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw !== null && THEMES.includes(raw as Theme) ? (raw as Theme) : 'system';
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

/** What the setting means right now: `system` asks the OS, the two others answer for themselves. */
export function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  return typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

/** Stamps the root and the theme colour. Dark removes the attribute rather than setting one. */
export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  if (resolved === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
}

/** Stores the choice and paints it in one call: what the settings control uses. */
export function setTheme(theme: Theme): void {
  writeTheme(theme);
  applyTheme(theme);
}

/**
 * Applies the stored theme and follows `prefers-color-scheme` while the setting
 * reads `system`. Returns the function that drops the listener.
 */
export function startTheme(): () => void {
  applyTheme(readTheme());
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(LIGHT_QUERY);
  const onchange = () => {
    if (readTheme() === 'system') applyTheme('system');
  };
  query.addEventListener('change', onchange);
  return () => query.removeEventListener('change', onchange);
}
