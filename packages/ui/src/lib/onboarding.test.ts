import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_VERSION,
  onboardingSeen,
  readOnboarding,
  steps,
  writeOnboarding
} from './onboarding';

/**
 * What the device remembers about the tour, and which screens this build shows.
 * The storage is the theme's model: anything unreadable answers "never seen",
 * which shows the tour rather than hiding it on a wrong guess.
 */

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

test('an untouched device has seen nothing, and closing the tour writes the version and the time', () => {
  expect(readOnboarding()).toBeNull();
  expect(onboardingSeen()).toBe(false);

  writeOnboarding(1_700_000_000_000);

  expect(readOnboarding()).toEqual({ version: ONBOARDING_VERSION, at: 1_700_000_000_000 });
  expect(onboardingSeen()).toBe(true);
});

test('a record that is not one reads as never seen', () => {
  for (const raw of ['', 'not json', '[]', 'null', '"1"', '{}', '{"version":"1"}', '{"version":null}']) {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, raw);
    expect(readOnboarding()).toBeNull();
    expect(onboardingSeen()).toBe(false);
  }

  // A version this build does not know is still a record: the tour was seen,
  // and deciding what to do about the number is a later build's business.
  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: 99 }));
  expect(readOnboarding()).toEqual({ version: 99, at: 0 });
  expect(onboardingSeen()).toBe(true);
});

test('seven screens explain the app, the second asking who is using it', () => {
  const shown = steps();

  expect(shown[0]).toBe('welcome');
  expect(shown.at(-1)).toBe('privacy');
  expect(shown).toEqual(['welcome', 'profile', 'agents', 'usage', 'reach', 'quiet', 'privacy']);
  // A fresh array every call: the caller keeps its own and may not change ours.
  expect(steps()).not.toBe(shown);
  expect(steps(false)).not.toContain('privacy');
});
