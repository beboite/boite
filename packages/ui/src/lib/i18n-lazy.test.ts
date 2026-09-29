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
