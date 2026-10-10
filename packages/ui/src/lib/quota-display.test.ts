import { expect, test } from 'vitest';
import type { AccountQuota } from '@boite/contracts';
import { shownWindows } from './quota-display';

const at = 1_800_000_000_000;
const row: AccountQuota = {
  accountId: 'famille', providerId: 'claude', providerName: 'Claude', label: 'Famille', enabled: true, status: 'ready',
  windows: [
    { id: 'five-hour', label: '5 hours', usedPercent: 51, resetsAt: at },
    { id: 'seven-day-opus', label: 'Weekly Opus', usedPercent: 10, resetsAt: null },
    { id: 'seven-day', label: 'Weekly', usedPercent: 31, resetsAt: at + 86_400_000 },
  ],
  checkedAt: at, error: null,
};
const ids = (shown: ReturnType<typeof shownWindows>) => [shown.primary?.id ?? null, ...shown.others.map((window) => window.id)];

test('the account-wide weekly window leads by default, never the lowest one nor a per-model week', () => {
  expect(ids(shownWindows(row))).toEqual(['seven-day', 'five-hour', 'seven-day-opus']);
  expect(ids(shownWindows({ ...row, windows: [row.windows[0]!] }))).toEqual(['five-hour']);
  expect(shownWindows({ ...row, windows: [] }).primary).toBeNull();
});

test("the window Douane flags primary leads instead", () => {
  const windows = row.windows.map((window) => window.id === 'five-hour' ? { ...window, primary: true as const } : window);
  expect(ids(shownWindows({ ...row, windows }))).toEqual(['five-hour', 'seven-day-opus', 'seven-day']);
});

test('native ids and labels count as weekly', () => {
  for (const window of [{ id: 'seven_day', label: 'Weekly' }, { id: 'secondary', label: 'Weekly' }, { id: '3p-weekly', label: 'Third-party' }, { id: 'w', label: '7d' }]) {
    const windows = [{ id: 'five_hour', label: '5 hours', usedPercent: 0, resetsAt: null }, { ...window, usedPercent: 0, resetsAt: null }];
    expect(shownWindows({ ...row, windows }).primary?.id).toBe(window.id);
  }
  const model = [{ id: 'five_hour', label: '5 hours', usedPercent: 0, resetsAt: null }, { id: 'model:Opus', label: 'Opus weekly', usedPercent: 0, resetsAt: null }];
  expect(shownWindows({ ...row, windows: model }).primary?.id).toBe('five_hour');
});
