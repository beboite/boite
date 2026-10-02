import { expect, test } from 'vitest';
import { bytes, clockTime, elapsed, levelName, millis, quotaResetTime, quotaWindowName, relativeTime } from './format';
import { setLocaleSetting } from './i18n.svelte';

test('elapsed reads like a stopwatch', () => {
  expect(elapsed(0)).toBe('0s');
  expect(elapsed(12_900)).toBe('12s');
  expect(elapsed(281_000)).toBe('4m 41s');
  expect(elapsed(65_000)).toBe('1m 05s');
  expect(elapsed(3_720_000)).toBe('1h 02m');
  expect(elapsed(-5)).toBe('0s');
});

test('mail ages stay relative across days and clamp clock skew to now', async () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  expect(relativeTime(now + 60_000, now)).toBe('now');
  expect(relativeTime(now - 59_999, now)).toBe('now');
  expect(relativeTime(now - 120_000, now)).toBe('2 min. ago');
  expect(relativeTime(now - 7_200_000, now)).toBe('2 hr. ago');
  expect(relativeTime(now - 172_800_000, now)).toBe('2 days ago');
  await setLocaleSetting('fr');
  try {
    expect(relativeTime(now - 120_000, now).replace(/\s/g, ' ')).toBe('il y a 2 min');
    expect(relativeTime(now, now)).toBe("à l'instant");
  } finally { await setLocaleSetting('en'); }
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

test('durations, sizes, effort levels and quota windows follow the language the app speaks', async () => {
  const friday = new Date(2026, 8, 25, 20, 55).getTime();
  expect(quotaResetTime(friday)).toMatch(/^Friday /);
  expect(millis(38_000)).toBe('38.0 s');
  // Xhigh reads as the providers spell it, whatever label the core sends.
  expect(levelName({ id: 'xhigh', label: 'Extra high' })).toBe('Xhigh');
  await setLocaleSetting('fr');
  try {
    expect(millis(38_000)).toBe('38,0 s');
    expect(bytes(3.5 * 1024 ** 3)).toBe('3,5 Go');
    expect(levelName({ id: 'high', label: 'High' })).toBe('Élevé');
    expect(levelName({ id: 'fast', label: 'Fast' })).toBe('Rapide');
    expect(levelName({ id: 'xhigh', label: 'Extra high' })).toBe('Xhigh');
    // A level the app has no word for keeps the provider's.
    expect(levelName({ id: 'turbo', label: 'Turbo' })).toBe('Turbo');
    expect(quotaWindowName('Weekly')).toBe('Hebdomadaire');
    expect(quotaWindowName('5 hours')).toBe('5 heures');
    expect(quotaWindowName('Opus weekly')).toBe('Opus weekly');
    // The core joins a period to a model or a group: only the period changes language.
    expect(quotaWindowName('Weekly · Opus')).toBe('Hebdomadaire · Opus');
    expect(quotaWindowName('Gemini Pro · 5 hours')).toBe('Gemini Pro · 5 heures');
    expect(quotaWindowName('Credits')).toBe('Crédits');
    expect(quotaResetTime(friday)).toBe('vendredi 20:55');
    expect(levelName({ id: 'none', label: 'None' })).toBe('Aucun');
  } finally { await setLocaleSetting('en'); }
});
