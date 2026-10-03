import { afterEach, expect, test, vi } from 'vitest';
import { ATTENTION_IDLE_MS } from '@boite/contracts';
import { PRESENCE_POLL_MS, watchAttention, type Presence } from './attention';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('a page counts as watched while shown, focused and used lately', () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible', focused = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const seen: boolean[] = [];
  const stop = watchAttention((value) => seen.push(value));
  expect(seen).toEqual([true]);
  // The phone locked, or the app went to the background.
  visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  // The desktop window behind another one.
  focused = false; window.dispatchEvent(new Event('blur'));
  focused = true; window.dispatchEvent(new Event('focus'));
  // iOS may suspend the page with no visibility change first.
  window.dispatchEvent(new Event('pagehide'));
  window.dispatchEvent(new Event('pageshow'));
  expect(seen).toEqual([true, false, true, false, true, false, true]);
  // A PC left alone stops counting; a key or a touch brings it back, and use keeps it.
  vi.advanceTimersByTime(ATTENTION_IDLE_MS / 2);
  window.dispatchEvent(new Event('pointermove'));
  vi.advanceTimersByTime(ATTENTION_IDLE_MS - 1);
  expect(seen.at(-1)).toBe(true);
  vi.advanceTimersByTime(1);
  expect(seen.at(-1)).toBe(false);
  window.dispatchEvent(new KeyboardEvent('keydown'));
  expect(seen.slice(7)).toEqual([false, true]);
  stop();
  visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  expect(seen).toHaveLength(9);
});

test('in the desktop shell, the window in front and the whole system\'s input decide', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  // The webview keeps saying it has focus behind other windows and on a locked screen.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  let presence: Presence = { idleMs: 0, foreground: true };
  const seen: boolean[] = [], uses: number[] = [];
  const stop = watchAttention((value) => seen.push(value), (at) => uses.push(at), async () => presence);
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([true]);
  // Chris sends a message, then leaves the PC with Boite in front: no input anywhere.
  presence = { idleMs: ATTENTION_IDLE_MS, foreground: true };
  await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
  expect(seen).toEqual([true, false]);
  // Back, but in another application.
  presence = { idleMs: 0, foreground: false };
  await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
  expect(seen).toEqual([true, false]);
  // Boite in front again: its use is reported with the system's time of the last input.
  presence = { idleMs: 1_000, foreground: true };
  const before = uses.length;
  await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
  expect(seen).toEqual([true, false, true]);
  expect(uses.length).toBeGreaterThan(before);
  expect(Date.now() - uses.at(-1)!).toBe(1_000);
  stop();
});

test('an older shell without presence leaves the page\'s own signals', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const seen: boolean[] = [];
  const stop = watchAttention((value) => seen.push(value), undefined, () => Promise.reject(new Error('unknown command')));
  await Promise.resolve(); await Promise.resolve();
  window.dispatchEvent(new Event('focus'));
  expect(seen).toEqual([true]);
  stop();
});