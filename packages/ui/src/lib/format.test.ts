import { expect, test } from 'vitest';
import { bytes, clockTime, dayClock, effortName, elapsed, formatTokens, levelName, longDay, millis, quotaResetTime, quotaWindowName, relativeTime } from './format';
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
  expect(quotaResetTime(friday, friday)).toMatch(/^Friday /);
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
    expect(quotaResetTime(friday, friday)).toBe('vendredi 20:55');
    expect(levelName({ id: 'none', label: 'None' })).toBe('Aucun');
    // A subagent row names its model's effort in French, an unknown id as sent.
    const model = { effort: { levels: [{ id: 'high', label: 'High' }] } };
    expect(effortName(model, 'high')).toBe('Élevé');
    expect(effortName(model, 'turbo')).toBe('turbo');
    // A day heading and a token count, whatever language the OS speaks.
    expect(longDay(new Date(2026, 8, 15, 10, 31).getTime())).toBe('mardi 15 septembre');
    expect(formatTokens(84_400).replace(/\s/g, ' ')).toBe('84,4 k');
  } finally { await setLocaleSetting('en'); }
});

test('quota resets beyond the next seven calendar days show their date instead of an ambiguous weekday', async () => {
  const now = new Date(2026, 9, 25, 9, 0).getTime();
  const today = new Date(2026, 9, 25, 14, 0).getTime();
  const monthly = new Date(2026, 10, 22, 9, 35).getTime();
  const nextYear = new Date(2027, 0, 3, 9, 35).getTime();
  expect(quotaResetTime(today, now)).toMatch(/^Sunday /);
  expect(quotaResetTime(monthly, now)).toBe(`Nov 22 ${dayClock(monthly)}`);
  expect(quotaResetTime(nextYear, now)).toBe(`Jan 3, 2027 ${dayClock(nextYear)}`);
  await setLocaleSetting('fr');
  try {
    expect(quotaResetTime(today, now)).toBe('dimanche 14:00');
    expect(quotaResetTime(monthly, now)).toBe('22 nov. 09:35');
    expect(quotaResetTime(nextYear, now)).toBe('3 janv. 2027 09:35');
  } finally { await setLocaleSetting('en'); }
});

test('quota reset dates use local calendar boundaries, including across daylight saving changes', () => {
  const now = new Date(2026, 9, 24, 23, 0).getTime();
  const thisWeek = new Date(2026, 9, 30, 23, 30).getTime();
  const nextWeek = new Date(2026, 9, 31, 0, 0).getTime();
  const past = new Date(2026, 9, 17, 9, 35).getTime();
  expect(quotaResetTime(thisWeek, now)).toMatch(/^Friday /);
  expect(quotaResetTime(nextWeek, now)).toBe(`Oct 31 ${dayClock(nextWeek)}`);
  expect(quotaResetTime(past, now)).toBe(`Oct 17 ${dayClock(past)}`);
});
