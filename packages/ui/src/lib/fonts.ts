/*
 * The two faces the UI reads in, picked under Settings, Appearance and kept on
 * this device. Each choice is an attribute on `<html>` (`data-font`,
 * `data-mono`) whose rule in `app.css` swaps `--font-sans` or `--font-mono`, so
 * the stacks stay tokens beside the others and nothing here writes a family
 * name. The boot script of `index.html` stamps the same attributes before the
 * stylesheet, so a reload never flashes the default face first.
 *
 * Every bundled face is a variable woff2 in `public/fonts`, cut in two by
 * `unicode-range` (latin, then latin extended): the browser fetches a file
 * only once a glyph of its range is drawn in it, so an unpicked face costs
 * nothing but its `@font-face` rule.
 */

export const FONT_KEY = 'boite.font';
export const MONO_KEY = 'boite.font-mono';

export const FONTS = ['inter', 'geist', 'plex', 'atkinson', 'figtree', 'source', 'dm', 'system'] as const;
export type Font = (typeof FONTS)[number];

export const MONOS = ['geist', 'jetbrains', 'system'] as const;
export type Mono = (typeof MONOS)[number];

export const DEFAULT_FONT: Font = 'inter';
export const DEFAULT_MONO: Mono = 'geist';

function readKey<T extends string>(key: string, known: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value !== null && (known as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function stamp(attribute: 'font' | 'mono', value: string, fallback: string): void {
  const root = document.documentElement;
  if (value === fallback) delete root.dataset[attribute];
  else root.dataset[attribute] = value;
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage refused: the choice holds for this window.
  }
}

export function readFont(): Font {
  return readKey(FONT_KEY, FONTS, DEFAULT_FONT);
}

export function readMono(): Mono {
  return readKey(MONO_KEY, MONOS, DEFAULT_MONO);
}

export function setFont(font: Font): void {
  stamp('font', font, DEFAULT_FONT);
  store(FONT_KEY, font);
}

export function setMono(mono: Mono): void {
  stamp('mono', mono, DEFAULT_MONO);
  store(MONO_KEY, mono);
}

/** The stored faces from the mount on, and a change another window of this origin makes. */
export function startFonts(): () => void {
  stamp('font', readFont(), DEFAULT_FONT);
  stamp('mono', readMono(), DEFAULT_MONO);
  const update = (event: StorageEvent) => {
    if (event.key === FONT_KEY) stamp('font', readFont(), DEFAULT_FONT);
    if (event.key === MONO_KEY) stamp('mono', readMono(), DEFAULT_MONO);
  };
  window.addEventListener('storage', update);
  return () => window.removeEventListener('storage', update);
}
