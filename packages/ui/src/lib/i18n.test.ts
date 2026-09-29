import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { strings as en } from './strings';
import { fr } from './strings.fr';
import {
  activeLocale,
  detectLocale,
  DEFAULT_LOCALE,
  formatLocale,
  isLocale,
  loadLocale,
  LOCALE_STORAGE_KEY,
  localeSetting,
  readLocaleSetting,
  setLocaleSetting,
  startLocale,
  strings
} from './i18n.svelte';

/**
 * The language the UI speaks: what the machine asks for, what the device
 * stores, and the proxy that puts the answer in front of every component.
 */

/** jsdom ships one language; these tests hand it others for the length of a call. */
function speaks(...languages: string[]): void {
  Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(window.navigator, 'language', { value: languages[0] ?? '', configurable: true });
}

const own = [...navigator.languages];

// French is its own chunk (i18n-lazy.test.ts covers the wait): loaded once
// here, every switch below is immediate.
beforeAll(() => loadLocale('fr'));

beforeEach(() => {
  window.localStorage.clear();
  setLocaleSetting('system');
});

afterEach(() => {
  speaks(...own);
  window.localStorage.clear();
  setLocaleSetting('system');
  document.documentElement.removeAttribute('lang');
});

test('the machine language decides, a region is dropped, and anything else is English', () => {
  speaks('fr-CA', 'en-US');
  expect(detectLocale()).toBe('fr');

  speaks('FR');
  expect(detectLocale()).toBe('fr');

  speaks('de-DE', 'it');
  expect(detectLocale()).toBe(DEFAULT_LOCALE);

  speaks();
  expect(detectLocale()).toBe(DEFAULT_LOCALE);

  expect(isLocale('fr')).toBe(true);
  expect(isLocale('de')).toBe(false);
});

test('a stored choice that is not a language is the system one', () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'de');
  expect(readLocaleSetting()).toBe('system');

  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
  expect(readLocaleSetting()).toBe('fr');

  window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  expect(readLocaleSetting()).toBe('system');
});

test('picking a language stores it, stamps the root and swaps every sentence at once', () => {
  expect(activeLocale()).toBe('en');
  expect(strings.common.yes).toBe('yes');
  expect(strings.settings.tabs.appearance).toBe('Appearance');

  setLocaleSetting('fr');

  expect(localeSetting()).toBe('fr');
  expect(activeLocale()).toBe('fr');
  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('fr');
  expect(document.documentElement.lang).toBe('fr');
  expect(strings.common.yes).toBe('oui');
  expect(strings.settings.tabs.appearance).toBe('Apparence');
  // A list of sentences comes over whole rather than one proxy per item.
  expect(strings.settings.accentNames[0]).toBe('Bleu');
  expect(Array.isArray(strings.settings.accentNames)).toBe(true);

  setLocaleSetting('en');
  expect(strings.common.yes).toBe('yes');
});

test('the stored choice comes back on boot, and system follows the machine', () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');

  startLocale();

  expect(activeLocale()).toBe('fr');
  expect(document.documentElement.lang).toBe('fr');

  // `system` reads the machine, which jsdom says is English here.
  setLocaleSetting('system');
  expect(activeLocale()).toBe('en');
  expect(document.documentElement.lang).toBe('en');
});

test('formatted update messages use the current language and preserve arguments', () => {
  setLocaleSetting('en');
  expect(strings.harnessUpdates.available('Claude', '1.2')).toBe('Claude 1.2 is available');
  setLocaleSetting('fr');
  expect(strings.harnessUpdates.available('Claude', '1.2')).toBe('Claude 1.2 est disponible');
  expect(strings.harnessUpdates.on('Desktop')).toBe('Sur Desktop');
});

test('dates and numbers keep the machine region when it speaks the same language', () => {
  speaks('fr-CA', 'en-US');
  setLocaleSetting('fr');
  expect(formatLocale()).toBe('fr-CA');

  // An English app on a French machine reads as English, not as fr-CA.
  setLocaleSetting('en');
  expect(formatLocale()).toBe('en-US');

  speaks('de-DE');
  setLocaleSetting('fr');
  expect(formatLocale()).toBe('fr');
});

test('a translation only carries sentences English has, with the same kind and the same slots', () => {
  // A sentence French lacks is allowed here, since main and the nightly show it
  // in English; `scripts/ci/translations.ts --release` is what refuses a release
  // that still lacks one.
  const kind = (value: unknown): string => (Array.isArray(value) ? `array.${value.length}` : typeof value);
  const slots = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((hit) => hit[1] ?? '').sort();
  const walk = (a: unknown, b: unknown, path: string[]): void => {
    const at = path.join('.');
    expect({ at, kind: kind(b) }).toEqual({ at, kind: kind(a) });
    if (typeof a === 'string') {
      expect({ at, slots: slots(b as string) }).toEqual({ at, slots: slots(a) });
      return;
    }
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return;
    for (const [key, child] of Object.entries(b as Record<string, unknown>)) walk((a as Record<string, unknown>)[key], child, [...path, key]);
  };
  walk(en, fr, []);
});

test('a sentence a translation has not got is the English one, and the rest stay translated', () => {
  const block = fr.common as unknown as Record<string, string>;
  const kept = block['yes'];
  delete block['yes'];
  setLocaleSetting('fr');

  expect(strings.common.yes).toBe('yes');
  expect(strings.common.no).toBe('non');
  expect('yes' in strings.common).toBe(true);
  expect(Object.keys(strings.common)).toContain('yes');

  block['yes'] = kept as string;
  expect(strings.common.yes).toBe('oui');
});

test('a component cannot write a sentence back', () => {
  expect(() => {
    (strings.common as unknown as Record<string, string>)['yes'] = 'nope';
  }).toThrow(/read-only/);
});
