import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyColors, COLORS_KEY, colorsBootScript, PALETTES, presetPalette, readPalette, resetAccentColor, resetColors, setPalette, startColors } from './theme-colors';
import { contrast, editPalette, improvePaletteContrast, mixColor, paletteTokens } from './color-math';

beforeEach(() => {
  // Install the real palette tokens, which jsdom cannot load from app.css.
  const css = readFileSync(resolve('src/app.css'), 'utf8');
  for (const match of css.matchAll(/(--palette-[\w-]+):\s*(#[0-9a-f]{6});/gi)) {
    // Production CSS minification shortens repeated hex pairs, including OLED black.
    const compact = match[2]!.replace(/^#(.)\1(.)\2(.)\3$/i, '#$1$2$3');
    document.documentElement.style.setProperty(match[1]!, compact);
  }
});
afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('style'); });

test('palettes persist per appearance and reset removes every derived token', () => {
  const palette = { background: '#14243a', frame: '#1c2c42', surface: '#203149', foreground: '#e2ecf6', accent: '#77bbff' };
  setPalette('dark', palette);
  expect(readPalette('dark')).toEqual(palette);
  expect(readPalette('light').background).not.toBe(palette.background);
  applyColors('dark');
  expect(document.documentElement.style.getPropertyValue('--color-background')).toBe(palette.background);
  resetColors('dark');
  expect(document.documentElement.style.getPropertyValue('--color-background')).toBe('');
  expect(document.documentElement.style.getPropertyValue('--color-muted-foreground')).toBe('');
});

test('invalid stored colours cannot be applied, while valid appearance data survives', () => {
  const palette = { background: '#14243a', frame: '#1c2c42', surface: '#203149', foreground: '#e2ecf6', accent: '#77bbff' };
  localStorage.setItem(COLORS_KEY, JSON.stringify({ version: 1, dark: { ...palette, background: 'url(https://invalid.test)' }, light: palette }));
  applyColors('dark');
  expect(document.documentElement.style.getPropertyValue('--color-background')).toBe('');
  expect(readPalette('light')).toEqual(palette);
  localStorage.setItem(COLORS_KEY, JSON.stringify({ version: 1, dark: { ...palette, details: { codeBackground: 'url(https://invalid.test)', success: '#A6E3A1', unknown: '#ffffff' } } }));
  expect(readPalette('dark').details).toEqual({ success: '#a6e3a1' });
  new Function(colorsBootScript())();
  expect(document.documentElement.style.getPropertyValue('--color-code-background')).toBe(palette.surface);
  localStorage.setItem(COLORS_KEY, 'null');
  expect(() => applyColors('dark')).not.toThrow();
});

test('the prepaint script and runtime apply the same colours and readable secondary text', () => {
  const palette = { background: '#14243a', frame: '#1c2c42', surface: '#203149', foreground: '#e2ecf6', accent: '#77bbff' };
  setPalette('dark', palette);
  const expected = Object.fromEntries(Object.keys(paletteTokens(palette)).map(key => [key, document.documentElement.style.getPropertyValue(key)]));
  document.documentElement.removeAttribute('style');
  new Function(colorsBootScript())();
  expect(Object.fromEntries(Object.keys(expected).map(key => [key, document.documentElement.style.getPropertyValue(key)]))).toEqual(expected);
  const tokens = paletteTokens(palette);
  for (const ground of ['--color-background', '--color-frame', '--color-surface', '--color-surface-2', '--color-surface-3']) {
    expect(contrast(tokens['--color-muted-foreground']!, tokens[ground]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['--color-subtle']!, tokens[ground]!)).toBeGreaterThanOrEqual(4.5);
  }
});

test('built-in palettes have readable text in both appearances and opposite grounds can be corrected', () => {
  const grounds = ['--color-background', '--color-frame', '--color-surface', '--color-surface-2', '--color-surface-3'];
  for (const mode of ['dark', 'light'] as const) {
    for (const id of PALETTES) {
      const tokens = paletteTokens(presetPalette(id, mode));
      for (const ground of grounds) {
        for (const text of ['--color-foreground', '--color-muted-foreground', '--color-subtle']) {
          expect(contrast(tokens[text]!, tokens[ground]!), `${mode}/${id}: ${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const status of ['--color-success', '--color-danger']) {
          if (!tokens[status]) continue;
          expect(contrast(tokens[status]!, mixColor(tokens[ground]!, tokens[status]!, .14)), `${mode}/${id}: diff ${status}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(tokens['--color-code-foreground']!, tokens['--color-code-background']!), `${mode}/${id}: code`).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const background of ['#ffffff', '#000000']) {
    const tokens = paletteTokens(improvePaletteContrast({ background, frame: '#000000', surface: '#ffffff', foreground: background, accent: '#77bbff', details: { surfaceLow: '#000000', surfaceHigh: '#ffffff' } }));
    for (const ground of grounds) expect(contrast(tokens['--color-foreground']!, tokens[ground]!)).toBeGreaterThanOrEqual(4.5);
  }
});

test('another window can apply and reset colours without retaining stale tokens or browser chrome', () => {
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  document.head.append(meta);
  const stop = startColors();
  try {
    const palette = { background: '#14243a', frame: '#1c2c42', surface: '#203149', foreground: '#e2ecf6', accent: '#77bbff' };
    localStorage.setItem(COLORS_KEY, JSON.stringify({ version: 1, dark: palette }));
    window.dispatchEvent(new StorageEvent('storage', { key: COLORS_KEY }));
    expect(document.documentElement.style.getPropertyValue('--color-background')).toBe(palette.background);
    expect(meta.content).toBe(palette.background);
    localStorage.removeItem(COLORS_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: COLORS_KEY }));
    expect(document.documentElement.style.getPropertyValue('--color-background')).toBe('');
    expect(meta.content).toBe('#101013');
  } finally { stop(); meta.remove(); }
});

test('curated code, status and selection colours survive persistence and prepaint, then reset cleanly', () => {
  const palette = presetPalette('tokyo-night', 'dark');
  const css = document.documentElement.style;
  const expected = css.getPropertyValue('--palette-dark-tokyo-night-code-background');
  expect(expected).toMatch(/^#[\da-f]{6}$/);
  setPalette('dark', palette);
  expect(css.getPropertyValue('--color-code-background')).toBe(expected);
  const tokens = paletteTokens(palette);
  for (const key of Object.keys(tokens)) css.removeProperty(key);
  new Function(colorsBootScript())();
  for (const key of ['--color-code-background', '--color-success', '--color-selection', '--color-accent-soft']) {
    expect(css.getPropertyValue(key)).toBe(tokens[key]);
  }
  resetColors('dark');
  for (const key of ['--color-code-background', '--color-success', '--color-selection', '--color-accent-soft']) {
    expect(css.getPropertyValue(key)).toBe('');
  }
  const edited = editPalette(palette, 'surface', '#ffffff');
  expect(paletteTokens(edited)['--color-code-background']).toBe('#ffffff');
  expect(edited.details?.success).toBe(palette.details?.success);
  expect(palette.details?.codeBackground).toBe(expected);
});

test('refused storage keeps a preset editable without changing the undo snapshot', () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage refused'); });
  try {
    const palette = presetPalette('catppuccin', 'dark');
    setPalette('dark', palette);
    const undo = readPalette('dark');
    resetAccentColor();
    expect(readPalette('dark').details?.accentSoft).toBeUndefined();
    expect(undo).toEqual(palette);
    setPalette('dark', undo);
    expect(readPalette('dark')).toEqual(palette);
  } finally { storage.mockRestore(); resetColors('dark'); }
});
