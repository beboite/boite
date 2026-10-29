import { expect, test } from 'vitest';
import { prefetchAllowed, prefetchNames } from './prefetch';

test('a data saver or a slow link fetches nothing ahead', () => {
  expect(prefetchAllowed(undefined)).toBe(true);
  expect(prefetchAllowed({ effectiveType: '4g' })).toBe(true);
  expect(prefetchAllowed({ effectiveType: '4g', saveData: true })).toBe(false);
  for (const effectiveType of ['slow-2g', '2g', '3g']) expect(prefetchAllowed({ effectiveType })).toBe(false);
});

test('the seen tour and a paired device terminal are left for when they are asked for', () => {
  const names = ['RightPanel', 'Onboarding', 'TerminalView'];
  expect(prefetchNames(names, { tourSeen: false, owner: true })).toEqual(names);
  expect(prefetchNames(names, { tourSeen: true, owner: true })).toEqual(['RightPanel', 'TerminalView']);
  expect(prefetchNames(names, { tourSeen: true, owner: false })).toEqual(['RightPanel']);
});
