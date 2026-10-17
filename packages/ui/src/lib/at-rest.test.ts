import { afterEach, expect, test, vi } from 'vitest';
import { PRESENCE_POLL_MS, WINDOW_FOCUS_EVENT, type Presence } from './attention';
import { REST_IDLE_MS, watchRest } from './at-rest';

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => { listeners.set(name, handler); return () => listeners.delete(name); },
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); listeners.clear(); });

const atRest = () => document.documentElement.hasAttribute('data-at-rest');

test('a page pauses its loops while hidden, behind another application or left alone, and plays them on the next use', () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible', focused = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const stop = watchRest(document.documentElement, null);
  expect(atRest()).toBe(false);
  // Another application in front of the window left visible.
  focused = false; window.dispatchEvent(new Event('blur'));
  expect(atRest()).toBe(true);
  focused = true; window.dispatchEvent(new Event('focus'));
  expect(atRest()).toBe(false);
  visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  expect(atRest()).toBe(true);
  visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  expect(atRest()).toBe(false);
  // Nobody at the PC; a mouse move over the page is somebody.
  vi.advanceTimersByTime(REST_IDLE_MS);
  expect(atRest()).toBe(true);
  window.dispatchEvent(new Event('pointermove'));
  expect(atRest()).toBe(false);
  stop();
  expect(atRest()).toBe(false);
  focused = false; window.dispatchEvent(new Event('blur'));
  expect(atRest()).toBe(false);
});

test('in the desktop shell, the window in front and the system\'s last input decide, and coming back plays at once', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  // The webview's own focus says nothing reliable: it moves to a browser surface of the same window.
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  let presence: Presence = { idleMs: 0, foreground: true };
  const source = vi.fn(async () => presence);
  const stop = watchRest(document.documentElement, source);
  await vi.advanceTimersByTimeAsync(0);
  expect(atRest()).toBe(false);
  // The page lost its focus to a browser surface: Boite is still in front.
  window.dispatchEvent(new Event('blur'));
  await vi.advanceTimersByTimeAsync(500);
  expect(atRest()).toBe(false);
  // Another application took the front; the system says so once the switch is over.
  listeners.get(WINDOW_FOCUS_EVENT)!({ payload: false });
  presence = { idleMs: 0, foreground: false };
  await vi.advanceTimersByTimeAsync(500);
  expect(atRest()).toBe(true);
  // Brought to front: the loops play before the shell answers.
  let answer: (value: Presence) => void = () => undefined;
  source.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  listeners.get(WINDOW_FOCUS_EVENT)!({ payload: true });
  expect(atRest()).toBe(false);
  presence = { idleMs: 0, foreground: true };
  answer(presence);
  await vi.advanceTimersByTimeAsync(0);
  expect(atRest()).toBe(false);
  // In front, nobody at the PC for two minutes, then a key anywhere on the system.
  presence = { idleMs: REST_IDLE_MS, foreground: true };
  await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
  expect(atRest()).toBe(true);
  presence = { idleMs: 200, foreground: true };
  await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
  expect(atRest()).toBe(false);
  stop();
  expect(listeners.has(WINDOW_FOCUS_EVENT)).toBe(false);
});
