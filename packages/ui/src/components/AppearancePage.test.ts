import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AppearancePage from './AppearancePage.svelte';
import { FONT_KEY, MONO_KEY } from '../lib/fonts';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

function pressed(testid: string): string | null {
  return document.querySelector(`[data-testid=${testid}]`)?.getAttribute('aria-pressed') ?? null;
}

test('faces picked in another window move the selected buttons here', () => {
  running = mount(AppearancePage, { target: document.body });
  flushSync();
  expect(pressed('font-inter')).toBe('true');
  expect(pressed('font-mono-geist')).toBe('true');

  localStorage.setItem(FONT_KEY, 'plex');
  localStorage.setItem(MONO_KEY, 'jetbrains');
  window.dispatchEvent(new StorageEvent('storage', { key: FONT_KEY }));
  window.dispatchEvent(new StorageEvent('storage', { key: MONO_KEY }));
  flushSync();

  expect(pressed('font-plex')).toBe('true');
  expect(pressed('font-inter')).toBe('false');
  expect(pressed('font-mono-jetbrains')).toBe('true');
  expect(pressed('font-mono-geist')).toBe('false');
});
