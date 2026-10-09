import { describe, expect, test } from 'bun:test';
import { checkSettingsPatch, quotaWindowKind } from '@boite/contracts';

const kind = (id: string, label = id) => quotaWindowKind({ id, label });

describe('quota window kinds', () => {
  test('native Claude and Codex windows sort by their length', () => {
    expect(kind('five_hour', '5 hours')).toBe('hours');
    expect(kind('seven_day', 'Weekly')).toBe('weekly');
    expect(kind('seven_day_opus', 'Weekly · Opus')).toBe('model');
    expect(kind('model:Opus', 'Weekly · Opus')).toBe('model');
    expect(kind('primary', '5 hours')).toBe('hours');
    expect(kind('secondary', 'Weekly')).toBe('weekly');
    expect(kind('secondary', 'Monthly')).toBe('monthly');
  });

  test('Douane windows sort the same, its old session copy included', () => {
    expect(kind('five-hour', '5 hours')).toBe('hours');
    expect(kind('seven-day', 'Weekly')).toBe('weekly');
    expect(kind('seven-day-opus', 'Weekly Opus')).toBe('model');
    expect(kind('session-all', 'session')).toBe('hours');
    expect(kind('gemini-5h', 'Gemini 5h')).toBe('hours');
    expect(kind('3p-weekly', 'Third-party weekly')).toBe('weekly');
    expect(kind('daily', 'Daily')).toBe('daily');
    expect(kind('window-period', 'Credits')).toBe('other');
  });
});

describe('quota display settings', () => {
  test('hidden kinds must be known and come back in canonical order without repeats', () => {
    const checked = checkSettingsPatch({ quotaHiddenWindows: ['weekly', 'hours', 'weekly'] });
    expect(checked).toMatchObject({ ok: true });
    expect(checked.ok && checked.patch.quotaHiddenWindows).toEqual(['hours', 'weekly']);
    expect(checkSettingsPatch({ quotaHiddenWindows: ['yearly'] as never })).toMatchObject({ ok: false, field: 'quotaHiddenWindows' });
    expect(checkSettingsPatch({ quotaHiddenWindows: 'weekly' as never })).toMatchObject({ ok: false, field: 'quotaHiddenWindows' });
  });

  test('a primary window maps an account id to a window id', () => {
    expect(checkSettingsPatch({ quotaPrimary: { 'a-claude': 'seven_day' } })).toMatchObject({ ok: true });
    expect(checkSettingsPatch({ quotaPrimary: {} })).toMatchObject({ ok: true });
    for (const bad of [[], { a: '' }, { a: ' ' }, { a: 7 }, { '': 'week' }, { a: 'x'.repeat(201) }, null]) {
      expect(checkSettingsPatch({ quotaPrimary: bad as never })).toMatchObject({ ok: false, field: 'quotaPrimary' });
    }
  });
});
