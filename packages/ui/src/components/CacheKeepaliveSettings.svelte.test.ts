import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CacheKeepalive, Settings } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import CacheKeepaliveSettings from './CacheKeepaliveSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;

function render(cacheKeepalive: CacheKeepalive | null, { owner = true, refuse = false } = {}) {
  const store = $state({
    owner,
    settings: { cacheKeepalive } as Partial<Settings>,
    saveSettings: vi.fn(async (patch: Partial<Settings>) => {
      if (refuse) return false;
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(CacheKeepaliveSettings, { target: document.body, props: { store: store as unknown as Store } });
  flushSync();
  return store;
}
const flip = async (checked: boolean) => {
  const box = input('cache-keepalive-on');
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};
const type = async (value: string) => {
  const field = input('cache-keepalive-hours');
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};

test('switching it on keeps the cache 12 hours, a whole number of hours saves, and off clears it', async () => {
  const store = render(null);
  expect(input('cache-keepalive-on').checked).toBe(false);
  expect(input('cache-keepalive-hours')).toBeNull();
  await flip(true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ cacheKeepalive: { hours: 12 } });
  expect(input('cache-keepalive-hours').value).toBe('12');

  await type('3');
  expect(store.settings.cacheKeepalive).toEqual({ hours: 3 });
  // Out of range: said beside the field, and nothing saved.
  await type('30');
  expect(input('cache-keepalive-hours-error').textContent).toContain('1 to 24');
  expect(store.settings.cacheKeepalive).toEqual({ hours: 3 });

  await flip(false);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ cacheKeepalive: null });
  expect(input('cache-keepalive-hours')).toBeNull();
});

test('a refused save puts the switch back, and a paired device sees no card', async () => {
  render(null, { refuse: true });
  await flip(true);
  expect(input('cache-keepalive-on').checked).toBe(false);
  await unmount(mounted!);
  mounted = undefined;

  render({ hours: 5 }, { owner: false });
  expect(document.querySelector('[data-testid="cache-keepalive-settings"]')).toBeNull();
});
