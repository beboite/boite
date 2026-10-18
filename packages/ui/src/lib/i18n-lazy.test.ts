import { afterEach, expect, test, vi } from 'vitest';
import { activeLocale, LOCALE_STORAGE_KEY, setLocaleSetting, startLocale, strings } from './i18n.svelte';

/**
 * French is its own chunk. This file runs in a fresh module, so nothing has
 * loaded it yet: English holds the screen until it lands, then all of it swaps.
 * The order of the tests matters; the first one does the loading.
 */

afterEach(() => {
  window.localStorage.clear();
});

test('a switch to French keeps English on screen until the catalogue has landed', async () => {
  const switching = setLocaleSetting('fr');
  expect(activeLocale()).toBe('en');
  expect(strings.common.yes).toBe('yes');
  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();

  await switching;
  expect(activeLocale()).toBe('fr');
  expect(strings.common.yes).toBe('oui');
  expect(document.documentElement.lang).toBe('fr');

  // Loaded once: the way back and forth is immediate.
  void setLocaleSetting('en');
  expect(strings.common.yes).toBe('yes');
  void setLocaleSetting('fr');
  expect(strings.common.yes).toBe('oui');
  await setLocaleSetting('system');
});

test('a pick made while French is still on its way outlives the fetch', async () => {
  vi.resetModules();
  const fresh = await import('./i18n.svelte');
  const slow = fresh.setLocaleSetting('fr');
  await fresh.setLocaleSetting('en');
  await slow;
  expect(fresh.activeLocale()).toBe('en');
  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
});

test('the boot resolves once the stored language can answer', async () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
  await startLocale();
  expect(strings.common.no).toBe('non');
  await setLocaleSetting('system');
  expect(strings.common.no).toBe('no');
});

test('a French device boots on the French chunk alone, never fetching English', async () => {
  // The mocks go in before a fresh copy of the module graph is imported, so
  // they see every import of the catalogues that copy makes, static ones too.
  vi.resetModules();
  let englishImported = false;
  vi.doMock('./strings.en', async (original) => {
    englishImported = true;
    return await original();
  });
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    const fresh = await import('./i18n.svelte');
    await fresh.startLocale();
    expect(englishImported).toBe(false);
    expect(fresh.activeLocale()).toBe('fr');
    expect(fresh.strings.common.yes).toBe('oui');
    // The chunk is whole (catalogue-plugin.ts): every key English has answers.
    const english = (await import('./strings.en')).strings;
    expect(Object.keys(fresh.strings.common)).toEqual(Object.keys(english.common));
  } finally {
    vi.doUnmock('./strings.en');
  }
});

test('the boot rejects when no catalogue loads, so main.ts shows its notice instead of an empty app', async () => {
  vi.resetModules();
  vi.doMock('./strings.en', () => { throw new Error('offline'); });
  vi.doMock('./strings.fr', () => { throw new Error('offline'); });
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    const fresh = await import('./i18n.svelte');
    await expect(fresh.startLocale()).rejects.toThrow();
  } finally {
    vi.doUnmock('./strings.en');
    vi.doUnmock('./strings.fr');
  }
});
