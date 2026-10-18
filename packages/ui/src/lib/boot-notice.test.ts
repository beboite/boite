import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { LOCALES } from './i18n.svelte';

// Vitest runs from packages/ui, like browser-floor.test.ts.
const html = readFileSync(resolve('index.html'), 'utf8');
const own = navigator.language;

/** The inline script that writes the notice of a page whose app never ran. */
function noticeScript(): string {
  const page = new DOMParser().parseFromString(html, 'text/html');
  const script = [...page.querySelectorAll('script:not([src])')]
    .map((element) => element.textContent ?? '')
    .find((body) => body.includes('__boiteBooted'));
  if (!script) throw new Error('index.html has no script that checks __boiteBooted');
  return script;
}

/**
 * Runs the script's load handler in a page whose app never booted, speaking
 * `language`, in a browser that has the floor's features or not. Returns the
 * notice and the handlers it left: the button's click and the `online` listener.
 */
function noticeFor(language: string, floor = false) {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  document.body.innerHTML = '<div id="app"></div>';
  const listen = vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  const reload = vi.fn();
  // jsdom has no CSS.supports, and its location cannot be replaced: both come in as the script's own names.
  new Function('location', 'CSS', noticeScript())({ reload }, { supports: () => floor });
  const handler = (type: string) => listen.mock.calls.find(([name]) => name === type)?.[1] as (() => void) | undefined;
  handler('load')?.();
  const online = handler('online');
  listen.mockRestore();
  const alert = document.querySelector('#app [role=alert]');
  // The sentence is the notice's first node whatever holds it, so a script that drew the wrong one fails here, not on a missing element.
  return { text: alert?.firstChild?.textContent ?? '', button: alert?.querySelector('button') ?? null, online, reload };
}

afterEach(() => {
  Object.defineProperty(window.navigator, 'language', { value: own, configurable: true });
  document.body.innerHTML = '';
});

test('a browser under the floor that never booted gets the notice in every language the app speaks', () => {
  const english = noticeFor('en-US').text;
  expect(english).toContain('Boite cannot start in this browser');
  expect(noticeFor('en-US').button).toBeNull();
  for (const locale of LOCALES.filter((code) => code !== 'en')) {
    const own = noticeFor(`${locale}-XX`).text;
    // A language missing from the script falls back to English: add its sentence there.
    expect(own, `index.html has no notice sentence for "${locale}"`).not.toBe(english);
    expect(own).not.toBe('');
  }
  expect(noticeFor('fr-CA').text).toContain('ne peut pas démarrer');
});

test('a browser that has what the floor has lost the app on the way: it says so and loads again, by hand or once back online', () => {
  const english = noticeFor('en-US', true);
  expect(english.text).toBe('Boite could not load. Check the connection, then try again.');
  expect(english.button?.textContent).toBe('Try again');
  english.button!.click();
  expect(english.reload).toHaveBeenCalledTimes(1);
  english.online!();
  expect(english.reload).toHaveBeenCalledTimes(2);
  for (const locale of LOCALES.filter((code) => code !== 'en')) {
    const own = noticeFor(`${locale}-XX`, true);
    expect(own.text, `index.html has no load failure sentence for "${locale}"`).not.toBe(english.text);
    expect(own.button?.textContent, `index.html has no retry label for "${locale}"`).not.toBe('Try again');
  }
  // The old browser gets neither: loading again would fail the same way.
  expect(noticeFor('en-US', false).online).toBeUndefined();
});

test('an unknown language gets the English sentences', () => {
  expect(noticeFor('de-DE').text).toBe(noticeFor('en').text);
  expect(noticeFor('de-DE', true).text).toBe(noticeFor('en', true).text);
});

test('a page that booted keeps its app and adds nothing', () => {
  (window as { __boiteBooted?: boolean }).__boiteBooted = true;
  try {
    expect(noticeFor('en').text).toBe('');
    expect(noticeFor('en', true).button).toBeNull();
  } finally {
    delete (window as { __boiteBooted?: boolean }).__boiteBooted;
  }
});
