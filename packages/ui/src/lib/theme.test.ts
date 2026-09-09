import { afterEach, beforeEach, expect, test } from 'vitest';
import { EXPERIMENTS_STORAGE_KEY, setExperiment } from './experiments';
import { applyTheme, readTheme, setTheme, startTheme, THEME_STORAGE_KEY } from './theme';

let meta: HTMLMetaElement;

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = '#101013';
  document.head.append(meta);
});

afterEach(() => {
  meta.remove();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

function color(): string {
  return meta.getAttribute('content') ?? '';
}

test('grain resolves to itself, stamps the root and takes the meta colour', () => {
  setExperiment('theme-grain', true);

  setTheme('grain');

  expect(readTheme()).toBe('grain');
  expect(document.documentElement.dataset.theme).toBe('grain');
  expect(color()).toBe('#1a1a1e');
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('grain');
});

test('an id this build does not offer is the system theme, which here is dark', () => {
  window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');

  expect(readTheme()).toBe('system');

  applyTheme(readTheme());

  // jsdom answers false to the light query, so system is dark and stamps nothing.
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(color()).toBe('#101013');
});

test('turning the experiment off puts a stored grain back on system, without a reload', () => {
  setExperiment('theme-grain', true);
  setTheme('grain');
  const stop = startTheme();
  expect(document.documentElement.dataset.theme).toBe('grain');

  setExperiment('theme-grain', false);

  expect(readTheme()).toBe('system');
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(color()).toBe('#101013');
  // The choice itself is kept, so switching the experiment back on returns it.
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('grain');
  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBe('[]');

  setExperiment('theme-grain', true);
  expect(readTheme()).toBe('grain');
  expect(document.documentElement.dataset.theme).toBe('grain');

  stop();
});

test('a listener dropped by the returned function stops repainting', () => {
  setExperiment('theme-grain', true);
  setTheme('grain');
  const stop = startTheme();

  stop();
  setExperiment('theme-grain', false);

  // The stamp is stale on purpose: nothing is listening any more.
  expect(document.documentElement.dataset.theme).toBe('grain');
  expect(readTheme()).toBe('system');
});
