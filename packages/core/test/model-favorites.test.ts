import { expect, test } from 'bun:test';
import { checkSettingsPatch, MODEL_FAVORITES_MAX } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { startTestCore } from './harness.ts';
import { thrown } from './settle.ts';

const opus = { providerId: 'claude', model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, account: 'Pro' };

test('favorites are bounded, trimmed and kept once each', () => {
  expect(checkSettingsPatch({ modelFavorites: { at: 5, items: [{ ...opus, account: ' Pro ', extra: 1 } as never, opus] } }))
    .toEqual({ ok: true, patch: { modelFavorites: { at: 5, items: [opus] } } });
  const many = Array.from({ length: MODEL_FAVORITES_MAX + 1 }, (_, i) => ({ providerId: 'codex', model: { id: `m${i}`, name: `M${i}` } }));
  const bad: unknown[] = [
    null, [], { at: -1, items: [] }, { at: 1.5, items: [] }, { at: 1, items: many },
    { at: 1, items: [{ providerId: '', model: opus.model }] },
    { at: 1, items: [{ ...opus, model: { id: 'x'.repeat(201), name: 'X' } }] },
    { at: 1, items: [{ ...opus, account: 'a\nb' }] },
    { at: 1, items: [{ ...opus, account: '' }] },
  ];
  for (const modelFavorites of bad) expect(checkSettingsPatch({ modelFavorites } as never)).toMatchObject({ ok: false, field: 'modelFavorites' });
});

test('the core keeps the later favorites, tells every client and lets a paired device only read them', async () => {
  const h = await startTestCore();
  try {
    const owner = await h.connect();
    const other = await h.connect();
    const heard = other.next('settings.updated');
    const later = { at: 2_000, items: [opus] };
    expect((await owner.call('settings.set', { modelFavorites: later })).modelFavorites).toEqual(later);
    expect((await heard).modelFavorites).toEqual(later);
    // A client still on an older list cannot overwrite the later one; the rest of its patch lands.
    const stored = await other.call('settings.set', { modelFavorites: { at: 1_000, items: [] }, warmProcessMinutes: 4 });
    expect(stored.modelFavorites).toEqual(later);
    expect(stored.warmProcessMinutes).toBe(4);
    expect(h.core.settings.get().modelFavorites).toEqual(later);
    expect(await thrown(owner.call('settings.set', { modelFavorites: { at: 3_000, items: 'Opus' } as never }))).toThrow('modelFavorites');

    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      expect((await phone.call('settings.get', {})).modelFavorites).toEqual(later);
      expect(await thrown(phone.call('settings.set', { modelFavorites: { at: 9_000, items: [] } }))).toThrow();
    } finally { phone.close(); }
    owner.close(); other.close();
  } finally { await h.stop(); }
});
