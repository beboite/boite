import { afterEach, expect, test } from 'vitest';
import { EXPERIMENTS_STORAGE_KEY } from './experiments';
import { FEATURES_STORAGE_KEY, isFeatureEnabled, resetFeatures, setFeature, subscribeFeatures } from './features';

afterEach(() => window.localStorage.clear());

test('graduated features are on until this device switches them off, whatever the old experiment said', () => {
  // A device that never opted into the experiments gets both features.
  window.localStorage.setItem(EXPERIMENTS_STORAGE_KEY, '["theme-grain"]');
  expect(isFeatureEnabled('chat-artifacts')).toBe(true);
  expect(isFeatureEnabled('agent-browser-control')).toBe(true);

  const seen: boolean[] = [];
  const off = subscribeFeatures(features => seen.push(features['agent-browser-control']));
  setFeature('agent-browser-control', false);
  off();
  expect(seen).toEqual([false]);
  expect(isFeatureEnabled('agent-browser-control')).toBe(false);
  expect(isFeatureEnabled('chat-artifacts')).toBe(true);
  expect(JSON.parse(window.localStorage.getItem(FEATURES_STORAGE_KEY)!)).toEqual({ 'chat-artifacts': true, 'agent-browser-control': false });

  // A malformed value falls back to the default rather than switching anything off.
  window.localStorage.setItem(FEATURES_STORAGE_KEY, '{"chat-artifacts":"no","agent-browser-control":false}');
  expect(isFeatureEnabled('chat-artifacts')).toBe(true);
  expect(isFeatureEnabled('agent-browser-control')).toBe(false);
  window.localStorage.setItem(FEATURES_STORAGE_KEY, 'not json');
  expect(isFeatureEnabled('agent-browser-control')).toBe(true);

  resetFeatures();
  expect(window.localStorage.getItem(FEATURES_STORAGE_KEY)).toBeNull();
});
