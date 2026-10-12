import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Elapsed from './Elapsed.svelte';

let component: Record<string, unknown> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

test('ticks while active and releases its timer on unmount', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  component = mount(Elapsed, { target: document.body, props: { startedAt: 0, finishedAt: null, active: true } });
  flushSync();
  expect(document.body.textContent?.trim()).toBe('10s');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect(document.body.textContent?.trim()).toBe('12s');
  await unmount(component); component = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

test('a settled duration stays frozen and an unknown finish is not fabricated', async () => {
  vi.useFakeTimers();
  component = mount(Elapsed, { target: document.body, props: { startedAt: 1000, finishedAt: 4000, active: false } });
  flushSync();
  const text = document.body.textContent;
  expect(text?.trim()).toBe('3s');
  await vi.advanceTimersByTimeAsync(20_000);
  flushSync();
  expect(document.body.textContent).toBe(text);
  expect(vi.getTimerCount()).toBe(0);
  await unmount(component);
  component = mount(Elapsed, { target: document.body, props: { startedAt: 1000, finishedAt: null, active: false } });
  flushSync();
  expect(document.querySelector('[data-testid=agent-elapsed]')).toBeNull();
});

test('a run past an hour reads in hours and minutes, not thousands of minutes', async () => {
  component = mount(Elapsed, { target: document.body, props: { startedAt: 0, finishedAt: (32 * 60 + 16) * 60_000 + 29_000, active: false } });
  flushSync();
  expect(document.body.textContent?.trim()).toBe('32h 16m');
});
