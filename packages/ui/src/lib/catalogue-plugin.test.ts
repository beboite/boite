import { expect, test } from 'vitest';
import { overEnglish } from '../../catalogue-plugin';

const english = `export const strings = {
  common: { yes: 'yes', no: 'no' },
  'odd-key': 'odd',
  count: (n: number) => n === 1 ? '1 file' : \`\${n} files\`,
  accents: ['Blue', 'Red'],
  deep: { inner: { kept: 'kept', both: 'both' } }
} as const;
export type Strings = typeof strings;
`;

const french = `import type { Translation } from './i18n.svelte';
export const fr: Translation = {
  deep: { inner: { both: 'les deux' } },
  common: { yes: 'oui' },
  count: (n: number) => n === 1 ? '1 fichier' : \`\${n} fichiers\`
};
`;

test('a translation ships whole: its sentences over English, English for the rest, in English order', () => {
  const source = overEnglish(english, french, 'fr');
  // The sample's one type annotation stripped, the module run as a function body.
  const module = { fr: new Function(source.replace('export const fr = ', 'return ').replace(/\(n: number\)/g, '(n)'))() as Record<string, unknown> };
  expect(module.fr).toEqual({
    common: { yes: 'oui', no: 'no' },
    'odd-key': 'odd',
    count: expect.any(Function),
    accents: ['Blue', 'Red'],
    deep: { inner: { kept: 'kept', both: 'les deux' } }
  });
  expect(Object.keys(module.fr)).toEqual(['common', 'odd-key', 'count', 'accents', 'deep']);
  expect((module.fr.count as (n: number) => string)(3)).toBe('3 fichiers');
});

test('a catalogue entry that is not a plain key and value is refused with its file', () => {
  expect(() => overEnglish(english, `export const fr = { ...other };`, 'fr')).toThrow(/strings\.fr\.ts: a catalogue holds plain/);
  expect(() => overEnglish(english, `export const de = {};`, 'fr')).toThrow(/strings\.fr\.ts: expected export const fr/);
});
