import { expect, test } from 'vitest';
import { releaseAge } from './release-age';

test('release ages use relative words in each locale and omit invalid dates', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  expect(releaseAge('2026-09-29T10:00:00Z', now, 'en')).toBe('2 hours ago');
  expect(releaseAge('2026-09-22T12:00:00Z', now, 'fr')).toBe('il y a 7 jours');
  expect(releaseAge('2026-09-28T12:00:00Z', now, 'en')).toBe('yesterday');
  expect(releaseAge('2026-09-30T12:00:00Z', now, 'en')).toBe('this minute');
  expect(releaseAge('invalid', now, 'en')).toBeNull();
  expect(releaseAge(null, now, 'en')).toBeNull();
});
