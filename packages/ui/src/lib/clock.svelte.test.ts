import { afterEach, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import { minuteClock, secondClock } from './clock.svelte';

afterEach(() => {
  Reflect.deleteProperty(document, 'hidden');
  vi.useRealTimers();
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

test('one interval serves every reader, stops while hidden and after the last reader', async () => {
  vi.useFakeTimers({ now: 0 });
  const seen: number[] = [];
  const stop = $effect.root(() => {
    $effect(() => { seen.push(secondClock.now); });
    $effect(() => { void secondClock.now; });
  });
  flushSync();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1_000);
  flushSync();
  expect(seen.at(-1)).toBe(1_000);

  setHidden(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(9_000);
  setHidden(false);
  flushSync();
  expect(seen.at(-1)).toBe(9_000);
  expect(vi.getTimerCount()).toBe(1);

  stop();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

test('the minute clock ticks at its own pace and reads the time outside a reader', async () => {
  vi.useFakeTimers({ now: 0 });
  vi.setSystemTime(5_000);
  expect(minuteClock.now).toBe(5_000);
  expect(vi.getTimerCount()).toBe(0);
  const seen: number[] = [];
  const stop = $effect.root(() => { $effect(() => { seen.push(minuteClock.now); }); });
  flushSync();
  vi.advanceTimersByTime(29_000);
  flushSync();
  expect(seen).toEqual([5_000]);
  vi.advanceTimersByTime(1_000);
  flushSync();
  expect(seen.at(-1)).toBe(35_000);
  stop();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
