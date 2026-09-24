import { expect, test } from 'bun:test';
import { compare, leaves, loadCatalogues } from './translations.ts';

const en = {
  common: { yes: 'yes', no: 'no' },
  chat: { sent: 'Sent to {name}', names: ['Blue', 'Green'], when: (at: string) => `at ${at}` },
  settings: { theme: { light: 'Light', dark: 'Dark' } }
};

test('a complete translation reports nothing', () => {
  const fr = {
    common: { yes: 'oui', no: 'non' },
    chat: { sent: 'Envoyé à {name}', names: ['Bleu', 'Vert'], when: (at: string) => `à ${at}` },
    settings: { theme: { light: 'Clair', dark: 'Sombre' } }
  };
  expect(compare(en, fr)).toEqual({ missing: [], extra: [], mismatched: [] });
});

test('a missing sentence or block is listed sentence by sentence', () => {
  const fr = { common: { yes: 'oui' }, chat: { sent: 'Envoyé à {name}', names: ['Bleu', 'Vert'], when: (at: string) => at } };
  expect(compare(en, fr).missing).toEqual(['common.no', 'settings.theme.light', 'settings.theme.dark']);
});

test('a key English lacks, other slots or another kind are refused by path', () => {
  const fr = {
    common: { yes: 'oui', no: 'non', maybe: 'peut-être', toString: 'texte' },
    chat: { sent: 'Envoyé à {nom}', names: ['Bleu'], when: 'plus tard' },
    settings: { theme: { light: 'Clair', dark: 'Sombre' } }
  };
  const report = compare(en, fr);
  // `toString` is on every object's prototype, not in English.
  expect(report.extra).toEqual(['common.maybe', 'common.toString']);
  expect(report.mismatched).toEqual([
    'chat.sent: expected slots {name}, got {nom}',
    'chat.names: expected list of 2, got list of 1',
    'chat.when: expected function, got string'
  ]);
  expect(report.missing).toEqual([]);
});

test('every sentence counts once, a list included', () => {
  expect(leaves(en)).toEqual(['common.yes', 'common.no', 'chat.sent', 'chat.names', 'chat.when', 'settings.theme.light', 'settings.theme.dark']);
});

test('the real catalogues load and no translation carries a key English lacks', async () => {
  const { reference, translations } = await loadCatalogues();
  expect([...translations.keys()]).toContain('fr');
  for (const [code, catalogue] of translations) {
    const report = compare(reference, catalogue);
    expect({ code, extra: report.extra, mismatched: report.mismatched }).toEqual({ code, extra: [], mismatched: [] });
  }
});
