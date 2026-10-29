import { expect, test } from 'bun:test';
import { checkRpcParams, checkSettingsPatch, RpcErrorCode } from '@boite/contracts';
import { startTestCore } from './harness.ts';

test('settings.set refuses what is not a settings object before anything is stored', async () => {
  const h = await startTestCore();
  try {
    const owner = await h.connect();
    const before = h.core.journal.getSetting('settings');
    const cases: [unknown, string][] = [[null, 'params'], ['wrong', 'params'], [[true], 'params'], [{ unknownTypo: true }, 'unknownTypo'], [{ shortAnswers: 'yes' }, 'shortAnswers']];
    for (const [params, field] of cases) {
      expect(await owner.call('settings.set', params as never).catch(error => error)).toMatchObject({ rpc: { code: RpcErrorCode.InvalidParams, data: { field } } });
    }
    expect(h.core.journal.getSetting('settings')).toEqual(before);
    // What older clients and saved settings still carry is dropped, never refused.
    const saved = await owner.call('settings.set', { shortAnswers: false, publicUrl: 'https://boite.example/', maxConcurrentTurns: 3 } as never);
    expect(saved).toMatchObject({ shortAnswers: false, publicUrl: 'https://boite.example' });
    expect(Object.hasOwn(h.core.journal.getSetting('settings') as object, 'maxConcurrentTurns')).toBe(false);
    owner.close();
  } finally { await h.stop(); }
});

test('the settings rules cover every setting and drop an absent value', () => {
  expect(checkSettingsPatch({ shortAnswers: undefined, muteAgents: true })).toEqual({ ok: true, patch: { muteAgents: true } });
  expect(checkRpcParams('settings.set', 7)).toMatchObject({ ok: false, field: 'params' });
  // A method without rules of its own goes to its handler as it came.
  expect(checkRpcParams('settings.get', 'anything')).toEqual({ ok: true, params: 'anything' });
});
