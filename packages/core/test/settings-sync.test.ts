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

test('the copy from the home leaves out what the follower keeps at the moment it writes, and only synced settings come this way', async () => {
  const h = await startTestCore();
  try {
    const owner = await h.connect();
    await owner.call('settings.set', { shortAnswers: false, syncOverrides: ['shortAnswers'] });
    const after = await owner.call('settings.follow', { patch: { shortAnswers: true, muteAgents: false, warmProcessMinutes: 9 } as never });
    expect(after).toMatchObject({ shortAnswers: false, muteAgents: false });
    expect(after.warmProcessMinutes).not.toBe(9);
    expect(await owner.call('settings.follow', { patch: 'all' } as never).catch((error: Error) => error.message)).toContain('patch');
    owner.close();
  } finally { await h.stop(); }
});
