import { afterEach, expect, test } from 'vitest';
import { DEVICE_STORAGE_KEY, deviceKey, dropDeviceKey, forgetLoadedKey, heldDeviceKey } from './device-key';

afterEach(() => {
  localStorage.clear();
  forgetLoadedKey();
});

test('machines connecting at once get one key between them, kept for the next start', async () => {
  const [first, second, third] = await Promise.all([deviceKey(), deviceKey(), deviceKey()]);
  expect(new Set([first.id, second.id, third.id]).size).toBe(1);
  expect(first.id).toMatch(/^[0-9a-f]{64}$/);
  forgetLoadedKey();
  expect(heldDeviceKey()?.id).toBe(first.id);
});

test('a refusal about a removed key drops it, and one about an older key leaves a newer one alone', async () => {
  const old = await deviceKey();
  // Another window was added again meanwhile, with a key of its own.
  localStorage.removeItem(DEVICE_STORAGE_KEY);
  forgetLoadedKey();
  const fresh = await deviceKey();
  expect(fresh.id).not.toBe(old.id);
  dropDeviceKey(old.id);
  expect(heldDeviceKey()?.id).toBe(fresh.id);
  dropDeviceKey(fresh.id);
  expect(localStorage.getItem(DEVICE_STORAGE_KEY)).toBeNull();
});
