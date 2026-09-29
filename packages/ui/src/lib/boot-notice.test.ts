import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { LOCALES } from './i18n.svelte';

// Vitest runs from packages/ui, like browser-floor.test.ts.
const html = readFileSync(resolve('index.html'), 'utf8');
const own = navigator.language;

/** The inline script that writes the too-old-browser sentence. */
function noticeScript(): string {
  const page = new DOMParser().parseFromString(html, 'text/html');
  const script = [...page.querySelectorAll('script:not([src])')]
    .map((element) => element.textContent ?? '')
    .find((body) => body.includes('__boiteBooted'));
  if (!script) throw new Error('index.html has no script that checks __boiteBooted');
  return script;
}

/** Runs the script's load handler in a page whose app never booted, speaking `language`. */
function noticeFor(language: string): string {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  document.body.innerHTML = '<div id="app"></div>';
  const listen = vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  new Function(noticeScript())();
  const handler = listen.mock.calls.find(([type]) => type === 'load')?.[1] as (() => void) | undefined;
  listen.mockRestore();
  handler?.();
  return document.querySelector('#app [role=alert]')?.textContent ?? '';
}

afterEach(() => {
  Object.defineProperty(window.navigator, 'language', { value: own, configurable: true });
  document.body.innerHTML = '';
});

test('a browser that never booted gets the notice in every language the app speaks', () => {
  const english = noticeFor('en-US');
  expect(english).toContain('Boite cannot start in this browser');
  for (const locale of LOCALES.filter((code) => code !== 'en')) {
    const own = noticeFor(`${locale}-XX`);
    // A language missing from the script falls back to English: add its sentence there.
    expect(own, `index.html has no notice sentence for "${locale}"`).not.toBe(english);
    expect(own).not.toBe('');
  }
  expect(noticeFor('fr-CA')).toContain('ne peut pas démarrer');
});

test('an unknown language gets the English sentence', () => {
  expect(noticeFor('de-DE')).toBe(noticeFor('en'));
});

test('a page that booted keeps its app and adds nothing', () => {
  (window as { __boiteBooted?: boolean }).__boiteBooted = true;
  try {
    expect(noticeFor('en')).toBe('');
  } finally {
    delete (window as { __boiteBooted?: boolean }).__boiteBooted;
  }
});
