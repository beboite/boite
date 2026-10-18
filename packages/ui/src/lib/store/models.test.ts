import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MODEL_CACHE_WRITE_MS, Models, sameJson } from './models.svelte';
import type { StoreContext } from './context';

const providers = [{ id: 'claude', name: 'Claude', protocol: 'claude-sdk', models: [], note: undefined }];
const accounts = [{ id: 'acc-1', providerId: 'claude', label: 'Main', status: 'ok' }];

function models(store: Record<string, unknown> = {}): Models {
  return new Models({ store: { providers, accounts, endpointUrl: 'ws://127.0.0.1:1', core: { dataDir: 'D:/data' }, ...store } } as unknown as StoreContext);
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('a burst of probes writes the model cache once, and leaving the page writes what waits', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const cache = models();
  for (let probe = 0; probe < 10; probe++) {
    cache.probedModels = { ...cache.probedModels, [`claude::acc-${probe}`]: [{ id: `m-${probe}`, name: `Model ${probe}` }] };
    cache.saveModels();
  }
  expect(setItem).not.toHaveBeenCalled();
  vi.advanceTimersByTime(MODEL_CACHE_WRITE_MS);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(Object.keys(JSON.parse(setItem.mock.calls[0]![1]).models)).toHaveLength(10);

  cache.saveModels();
  window.dispatchEvent(new Event('pagehide'));
  expect(setItem).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(MODEL_CACHE_WRITE_MS);
  expect(setItem).toHaveBeenCalledTimes(2);
});

test('a restore compares the lists without serializing them, and keeps a cache of other accounts out', () => {
  const writer = models();
  writer.probedModels = { 'claude::acc-1': [{ id: 'opus', name: 'Opus' }] };
  writer.saveModels();
  writer.flushModels();

  const stringify = vi.spyOn(JSON, 'stringify');
  const reader = models();
  reader.restoreModels();
  // The cache key alone is a string; the lists are compared field by field.
  expect(stringify.mock.calls.length).toBeLessThanOrEqual(1);
  expect(reader.probedModels['claude::acc-1']?.[0]?.id).toBe('opus');

  const other = models({ accounts: [{ ...accounts[0], label: 'Renamed' }] });
  other.restoreModels();
  expect(other.probedModels).toEqual({});
});

test('a held write keeps the accounts its models were probed under when the list changes', () => {
  const store = { providers, accounts, endpointUrl: 'ws://127.0.0.1:1', core: { dataDir: 'D:/data' } };
  const cache = new Models({ store } as unknown as StoreContext);
  cache.probedModels = { 'claude::acc-1': [{ id: 'opus', name: 'Opus' }] };
  cache.saveModels();
  // accounts.list lands with a renamed account, then restores the cache.
  store.accounts = [{ ...accounts[0]!, label: 'Renamed' }];
  cache.restoreModels();
  const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
  expect(stored.accounts[0].label).toBe('Main');
});

test('sameJson reads like JSON: undefined fields are absent, key order is free', () => {
  expect(sameJson({ a: 1, b: undefined, c: [1, undefined] }, { c: [1, null], a: 1 })).toBe(true);
  expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(sameJson([1, 2], [1, 2, 3])).toBe(false);
  expect(sameJson({ a: { b: 'x' } }, { a: { b: 'y' } })).toBe(false);
});
