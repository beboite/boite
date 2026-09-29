import { expect, test, vi } from 'vitest';
import { prefetchAllowed, prefetchNames, whenIdle } from './prefetch';

test('a data saver or a slow link fetches nothing ahead', () => {
  expect(prefetchAllowed(undefined)).toBe(true);
  expect(prefetchAllowed({ effectiveType: '4g' })).toBe(true);
  expect(prefetchAllowed({ effectiveType: '4g', saveData: true })).toBe(false);
  for (const effectiveType of ['slow-2g', '2g', '3g']) expect(prefetchAllowed({ effectiveType })).toBe(false);
});

test('the seen tour and a paired device terminal are left for when they are asked for', () => {
  const names = ['RightPanel', 'Onboarding', 'TerminalDrawer'];
  expect(prefetchNames(names, { tourSeen: false, owner: true })).toEqual(names);
  expect(prefetchNames(names, { tourSeen: true, owner: true })).toEqual(['RightPanel', 'TerminalDrawer']);
  expect(prefetchNames(names, { tourSeen: true, owner: false })).toEqual(['RightPanel']);
});

test('an idle task can be cancelled before it runs', () => {
  vi.useFakeTimers();
  try {
    const task = vi.fn();
    whenIdle(task)();
    vi.advanceTimersByTime(2000);
    expect(task).not.toHaveBeenCalled();
    whenIdle(task);
    vi.advanceTimersByTime(2000);
    expect(task).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
