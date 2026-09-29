import { afterEach, expect, test } from 'vitest';
import { DEFAULT_FONT, FONT_KEY, MONO_KEY, readFont, readMono, setFont, setMono, startFonts } from './fonts';

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.font;
  delete document.documentElement.dataset.mono;
});

test('the default face stamps nothing, another one stamps its attribute and is kept', () => {
  expect(readFont()).toBe(DEFAULT_FONT);
  setFont('atkinson');
  expect(document.documentElement.dataset.font).toBe('atkinson');
  expect(localStorage.getItem(FONT_KEY)).toBe('atkinson');
  setFont(DEFAULT_FONT);
  expect(document.documentElement.dataset.font).toBeUndefined();
  setMono('jetbrains');
  expect(document.documentElement.dataset.mono).toBe('jetbrains');
  expect(readMono()).toBe('jetbrains');
});

test('a stored face nobody offers reads as the default', () => {
  localStorage.setItem(FONT_KEY, 'comic-sans');
  localStorage.setItem(MONO_KEY, 'courier');
  const stop = startFonts();
  expect(readFont()).toBe(DEFAULT_FONT);
  expect(document.documentElement.dataset.font).toBeUndefined();
  expect(document.documentElement.dataset.mono).toBeUndefined();
  stop();
});

test('a face picked in another window of this origin follows here', () => {
  const stop = startFonts();
  localStorage.setItem(FONT_KEY, 'plex');
  window.dispatchEvent(new StorageEvent('storage', { key: FONT_KEY }));
  expect(document.documentElement.dataset.font).toBe('plex');
  stop();
});
