import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AppearancePage from './AppearancePage.svelte';
import { FONT_KEY, MONO_KEY } from '../lib/fonts';
import type { Store } from '../lib/store.svelte';
import { chatPrefs, CHAT_PREFS_STORAGE_KEY, readChatPrefs } from '../lib/chat-prefs.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  localStorage.clear();
  Object.assign(chatPrefs, readChatPrefs());
});

function pressed(testid: string): string | null {
  return document.querySelector(`[data-testid=${testid}]`)?.getAttribute('aria-pressed') ?? null;
}

test('file grouping and automatic previews default to compact and persist independently', () => {
  running = mount(AppearancePage, { target: document.body, props: { store: { owner: true } as Store } });
  flushSync();
  const group = document.querySelector<HTMLInputElement>('[data-testid=chat-group-changes]')!;
  const preview = document.querySelector<HTMLInputElement>('[data-testid=chat-expand-diffs]')!;
  expect(group.checked).toBe(true);
  expect(preview.checked).toBe(false);
  group.click(); preview.click(); flushSync();
  expect(readChatPrefs()).toEqual({ groupChanges: false, expandDiffs: true });
  localStorage.setItem(CHAT_PREFS_STORAGE_KEY, JSON.stringify({ groupChanges: true, expandDiffs: false }));
  window.dispatchEvent(new StorageEvent('storage', { key: CHAT_PREFS_STORAGE_KEY })); flushSync();
  expect(group.checked).toBe(true);
  expect(preview.checked).toBe(false);
});

test('faces picked in another window move the selected buttons here', () => {
  // The page reads only `owner` from the store, to list the owner's own buttons.
  running = mount(AppearancePage, { target: document.body, props: { store: { owner: true } as unknown as Store } });
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
