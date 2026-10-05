import { afterEach, expect, test } from 'vitest';
import { EXPERIMENTS_STORAGE_KEY } from './experiments';
import { FEATURES_STORAGE_KEY, isFeatureEnabled, resetFeatures, setFeature, subscribeFeatures } from './features';

afterEach(() => window.localStorage.clear());

test('a graduated feature is on until this device switches it off, whatever the old experiment said', () => {
  // A device that never opted into the experiment gets the feature.
  window.localStorage.setItem(EXPERIMENTS_STORAGE_KEY, '["theme-grain"]');
  expect(isFeatureEnabled('chat-artifacts')).toBe(true);

  const seen: boolean[] = [];
  const off = subscribeFeatures(features => seen.push(features['chat-artifacts']));
  setFeature('chat-artifacts', false);
  off();
  expect(seen).toEqual([false]);
  expect(isFeatureEnabled('chat-artifacts')).toBe(false);
  expect(JSON.parse(window.localStorage.getItem(FEATURES_STORAGE_KEY)!)).toEqual({ 'chat-artifacts': false });

  // A malformed value, or a feature this build no longer has, falls back to the default.
  window.localStorage.setItem(FEATURES_STORAGE_KEY, '{"chat-artifacts":"no","agent-browser-control":false}');
  expect(isFeatureEnabled('chat-artifacts')).toBe(true);
  window.localStorage.setItem(FEATURES_STORAGE_KEY, 'not json');
  expect(isFeatureEnabled('chat-artifacts')).toBe(true);

  resetFeatures();
  expect(window.localStorage.getItem(FEATURES_STORAGE_KEY)).toBeNull();
});
