import { expect, test } from 'vitest';
import type { AccountQuota } from '@boite/contracts';
import { pinnedWindow, shownWindows } from './quota-display';

const at = 1_800_000_000_000;
const row: AccountQuota = {
  accountId: 'famille', providerId: 'claude', providerName: 'Claude', label: 'Famille', enabled: true, status: 'ready',
  windows: [
    { id: 'five-hour', label: '5 hours', usedPercent: 51, resetsAt: at },
    { id: 'seven-day', label: 'Weekly', usedPercent: 31, resetsAt: at + 86_400_000 },
    { id: 'seven-day-opus', label: 'Weekly Opus', usedPercent: 10, resetsAt: null },
  ],
  checkedAt: at, error: null,
};
const ids = (shown: ReturnType<typeof shownWindows>) => [shown.primary?.id ?? null, ...shown.others.map((window) => window.id)];

test('the weekly window leads by default, never the lowest one', () => {
  expect(ids(shownWindows(row))).toEqual(['seven-day', 'five-hour', 'seven-day-opus']);
  expect(ids(shownWindows({ ...row, windows: [row.windows[0]!] }))).toEqual(['five-hour']);
  expect(shownWindows({ ...row, windows: [] }).primary).toBeNull();
});

test('a pinned window leads and stays shown even when its kind is hidden', () => {
  const display = { quotaHiddenWindows: ['hours' as const, 'model' as const], quotaPrimary: { famille: 'five-hour' } };
  expect(ids(shownWindows(row, display))).toEqual(['five-hour', 'seven-day']);
  expect(pinnedWindow(row, display)).toBe('five-hour');
  // A pin naming a window the reading lost falls back to the automatic choice.
  const gone = { quotaPrimary: { famille: 'model:Sonnet' } };
  expect(ids(shownWindows(row, gone))).toEqual(['seven-day', 'five-hour', 'seven-day-opus']);
  expect(pinnedWindow(row, gone)).toBeNull();
});

test('hiding every kind leaves no primary, and only weekly shows when asked', () => {
  expect(shownWindows(row, { quotaHiddenWindows: ['hours', 'weekly', 'model'] })).toEqual({ primary: null, others: [] });
  expect(ids(shownWindows(row, { quotaHiddenWindows: ['hours', 'daily', 'monthly', 'model', 'other'] }))).toEqual(['seven-day']);
});

test("an older Douane's session copy of the five-hour window is dropped, a real one stays", () => {
  const copy = { id: 'session-all', label: 'session', usedPercent: 51, resetsAt: at };
  expect(ids(shownWindows({ ...row, windows: [...row.windows, copy] }))).toEqual(['seven-day', 'five-hour', 'seven-day-opus']);
  const distinct = { ...copy, usedPercent: 12 };
  expect(ids(shownWindows({ ...row, windows: [...row.windows, distinct] }))).toEqual(['seven-day', 'five-hour', 'seven-day-opus', 'session-all']);
});
