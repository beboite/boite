import { afterEach, expect, test } from 'vitest';
import { localePreloadScript } from './locale-preload';

const own = [...navigator.languages];

function speaks(...languages: string[]): void {
  Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(window.navigator, 'language', { value: languages[0] ?? '', configurable: true });
}

/** Runs the script the way index.html does and says what it preloaded. */
function preloaded(): string[] {
  document.head.querySelectorAll('link[rel=modulepreload]').forEach((link) => link.remove());
  new Function(localePreloadScript({ fr: './assets/strings.fr-abc.js' }))();
  return [...document.head.querySelectorAll<HTMLLinkElement>('link[rel=modulepreload]')].map((link) => link.getAttribute('href') ?? '');
}

afterEach(() => {
  speaks(...own);
  window.localStorage.clear();
  document.head.querySelectorAll('link[rel=modulepreload]').forEach((link) => link.remove());
});

test('a device set to French, or following a French machine, preloads the French chunk', () => {
  window.localStorage.setItem('boite.locale', 'fr');
  speaks('en-US');
  expect(preloaded()).toEqual(['./assets/strings.fr-abc.js']);

  window.localStorage.setItem('boite.locale', 'system');
  speaks('de-DE', 'fr-CA', 'en');
  expect(preloaded()).toEqual(['./assets/strings.fr-abc.js']);
});

test('an English device preloads nothing', () => {
  window.localStorage.setItem('boite.locale', 'en');
  speaks('fr-FR');
  expect(preloaded()).toEqual([]);

  window.localStorage.removeItem('boite.locale');
  speaks('en-GB', 'fr');
  expect(preloaded()).toEqual([]);

  speaks('de-DE');
  expect(preloaded()).toEqual([]);
});
