import { expect, test } from 'vitest';
import { readSettings, settledSetting, type RequestableKey, type Settings, type SettingAsk } from '@boite/contracts';
import { retiredHint, settingLabel, settingsReachable, settingValueText } from './setting-requests';

const open = (page: SettingAsk['page'], section: string | null): SettingAsk => ({ kind: 'open', page, section });

test('Show and Open are offered only where this client draws the target card', () => {
  // A paired device has no owner page and no owner card on a shared page: Open would land on Home.
  expect(settingsReachable(open('resources', 'limits'), { owner: false, phone: false })).toBe(false);
  expect(settingsReachable(open('general', 'worktrees'), { owner: false, phone: false })).toBe(false);
  expect(settingsReachable(open('appearance', 'theme'), { owner: false, phone: false })).toBe(true);
  // The live device stream runs on the owner's machine: only the owner's Experiments draws its card, on a phone too.
  expect(settingsReachable(open('experiments', 'device-stream'), { owner: false, phone: false })).toBe(false);
  expect(settingsReachable(open('experiments', 'device-stream'), { owner: true, phone: true })).toBe(true);
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

test('a reading is a copy: sorting or pushing to it leaves the settings and the defaults alone', () => {
  const settings = { browserOrigins: ['https://b.example', 'https://a.example'] } as Settings;
  const origins = (reading: ReturnType<typeof readSettings>) => reading.find((entry) => entry.key === 'browserOrigins')!.value as string[];
  origins(readSettings(settings)).sort();
  expect(settings.browserOrigins).toEqual(['https://b.example', 'https://a.example']);
  origins(readSettings({} as Settings)).push('https://c.example');
  expect(origins(readSettings({} as Settings))).toEqual([]);
});

test('a card about a graduated experiment is never settled by a core setting moving', () => {
  // Asked before the switch left the Experiments page: an old card in a thread.
  const card: SettingAsk = { kind: 'change', key: 'experiment.open-chat-links' as RequestableKey, value: true, previous: false, page: 'experiments', section: 'open-chat-links', sensitive: false, app: 'app-12345678' };
  expect(settledSetting(card, { agentCpuCapPercent: 40 } as Settings)).toBeNull();
});

test('a graduated experiment keeps its name, and one with no switch left says it is always on', () => {
  expect(settingLabel('experiment.edge-scrollbars' as RequestableKey)).toBe('Edge scrollbars');
  expect(settingLabel('experiment.press-preload' as RequestableKey)).toBe('Load on press');
  expect(retiredHint('experiment.press-preload')).toBe('This experiment is now always on.');
  expect(retiredHint('experiment.preview-comments')).toBe('This experiment has its own switch in Settings now.');
});
