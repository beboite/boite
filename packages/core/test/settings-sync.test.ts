import { expect, test } from 'bun:test';
import { checkSettingsPatch, isSyncKey, SYNC_KEYS, SYNC_OVERRIDES_MAX, SYNCED_SETTINGS } from '@boite/contracts';
import { startTestCore } from './harness.ts';

test('a machine that follows its group keeps what it changed: known keys, and the well-formed ones a later version names', async () => {
  const checked = checkSettingsPatch({ syncOverrides: ['shortAnswers', 'keybinding:panel', 'shortAnswers', 'brain:enabled', 'keybinding:a-later-command'] });
  expect(checked).toEqual({ ok: true, patch: { syncOverrides: ['shortAnswers', 'keybinding:panel', 'brain:enabled', 'keybinding:a-later-command'] } });
  for (const syncOverrides of [['two words'], [3], 'shortAnswers', ['keybinding:'], Array.from({ length: SYNC_OVERRIDES_MAX + 1 }, (_, index) => `key${index}`)]) {
    expect(checkSettingsPatch({ syncOverrides } as never)).toMatchObject({ ok: false, field: 'syncOverrides' });
  }
  expect(SYNCED_SETTINGS.every(isSyncKey)).toBe(true);
  expect([isSyncKey('keybinding:panel'), isSyncKey('brain:path'), isSyncKey('warmProcessMinutes')]).toEqual([true, false, false]);
  expect(SYNC_KEYS.length).toBeLessThanOrEqual(SYNC_OVERRIDES_MAX);

  const h = await startTestCore();
  try {
    const owner = await h.connect();
    expect((await owner.call('settings.set', { syncOverrides: ['muteAgents', 'muteAgents'] })).syncOverrides).toEqual(['muteAgents']);
    expect(h.core.settings.get().syncOverrides).toEqual(['muteAgents']);
    owner.close();
  } finally { await h.stop(); }
});
