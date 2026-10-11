import { expect, test } from 'vitest';
import type { SettingAsk } from '@boite/contracts';
import { settingsReachable, settingValueText } from './setting-requests';

const open = (page: SettingAsk['page'], section: string | null): SettingAsk => ({ kind: 'open', page, section });

test('Show and Open are offered only where this client draws the target card', () => {
  // A paired device has no owner page and no owner card on a shared page: Open would land on Home.
  expect(settingsReachable(open('resources', 'limits'), { owner: false, phone: false })).toBe(false);
  expect(settingsReachable(open('general', 'worktrees'), { owner: false, phone: false })).toBe(false);
  expect(settingsReachable(open('appearance', 'theme'), { owner: false, phone: false })).toBe(true);
  // A phone browser lacks the desktop's General, Advanced and pairing cards.
  expect(settingsReachable(open('resources', 'limits'), { owner: true, phone: true })).toBe(true);
  expect(settingsReachable(open('general', 'conversations'), { owner: true, phone: true })).toBe(false);
  expect(settingsReachable(open('advanced', 'origins'), { owner: true, phone: true })).toBe(false);
  expect(settingsReachable(open('machines', 'devices'), { owner: true, phone: true })).toBe(false);
  expect(settingsReachable(open('advanced', 'origins'), { owner: true, phone: false })).toBe(true);
});

test('an automatic compaction change that only adds a moment reads differently from the current one', () => {
  const before = settingValueText('autoCompact', { tokens: 8000, moments: ['background'] });
  const after = settingValueText('autoCompact', { tokens: 8000, moments: ['background', 'turn-end'] });
  expect(after).not.toBe(before);
  expect(after.startsWith(before)).toBe(true);
});
