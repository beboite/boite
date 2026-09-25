import { expect, test } from 'vitest';
import { bytes, clockTime, elapsed, levelName, millis, quotaWindowName } from './format';
import { setLocaleSetting } from './i18n.svelte';

test('elapsed reads like a stopwatch', () => {
  expect(elapsed(0)).toBe('0s');
  expect(elapsed(12_900)).toBe('12s');
  expect(elapsed(281_000)).toBe('4m 41s');
  expect(elapsed(65_000)).toBe('1m 05s');
  expect(elapsed(3_720_000)).toBe('1h 02m');
  expect(elapsed(-5)).toBe('0s');
});

test('clockTime gives the hour today, a weekday this week and a date beyond', () => {
  const now = new Date(2026, 8, 24, 18, 0).getTime();
  const today = new Date(2026, 8, 24, 10, 31).getTime();
  const monday = new Date(2026, 8, 21, 10, 31).getTime();
  const old = new Date(2026, 7, 2, 10, 31).getTime();
  expect(clockTime(today, now)).toMatch(/10:31/);
  expect(clockTime(monday, now)).not.toBe(clockTime(today, now));
  expect(clockTime(old, now)).toMatch(/10:31/);
  expect(clockTime(old, now).length).toBeGreaterThan(clockTime(today, now).length);
});

test('durations, sizes, effort levels and quota windows follow the language the app speaks', () => {
  expect(millis(38_000)).toBe('38.0 s');
  expect(levelName({ id: 'xhigh', label: 'Extra high' })).toBe('Extra high');
  setLocaleSetting('fr');
  try {
    expect(millis(38_000)).toBe('38,0 s');
    expect(bytes(3.5 * 1024 ** 3)).toBe('3,5 Go');
    expect(levelName({ id: 'high', label: 'High' })).toBe('Élevé');
    expect(levelName({ id: 'fast', label: 'Fast' })).toBe('Rapide');
    // A level the app has no word for keeps the provider's.
    expect(levelName({ id: 'turbo', label: 'Turbo' })).toBe('Turbo');
    expect(quotaWindowName('Weekly')).toBe('Hebdomadaire');
    expect(quotaWindowName('5 hours')).toBe('5 heures');
    expect(quotaWindowName('Opus weekly')).toBe('Opus weekly');
  } finally { setLocaleSetting('en'); }
});
