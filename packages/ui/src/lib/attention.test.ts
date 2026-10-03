import { afterEach, expect, test, vi } from 'vitest';
import { ATTENTION_IDLE_MS } from '@boite/contracts';
import { watchAttention } from './attention';

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
