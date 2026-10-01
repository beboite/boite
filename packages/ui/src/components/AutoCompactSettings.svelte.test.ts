import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AutoCompact, Settings } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import AutoCompactSettings from './AutoCompactSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;

function render(autoCompact: AutoCompact | null) {
  const store = $state({
    owner: true,
    settings: { autoCompact } as Partial<Settings>,
    saveSettings: vi.fn(async (patch: Partial<Settings>) => {
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(AutoCompactSettings, { target: document.body, props: { store: store as unknown as Store } });
  flushSync();
  return store;
}
const flip = async (id: string, checked: boolean) => {
  const box = input(id);
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};

test('switching it on asks for no size, and the last moment switched off turns it all off', async () => {
  const store = render(null);
  expect(input('auto-compact-threshold')).toBeNull();
  await flip('auto-compact-on', true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: null, moments: ['background', 'cache-expiry'] } });
  expect(input('auto-compact-turn-end').checked).toBe(false);
  expect(input('auto-compact-threshold').checked).toBe(false);
  expect(input('auto-compact-tokens')).toBeNull();

  await flip('auto-compact-turn-end', true);
  expect(store.settings.autoCompact?.moments).toEqual(['turn-end', 'background', 'cache-expiry']);
  for (const moment of ['turn-end', 'background', 'cache-expiry']) await flip(`auto-compact-${moment}`, false);
  expect(store.settings.autoCompact).toBeNull();
  expect(input('auto-compact-on').checked).toBe(false);
});

test('the size is its own switch: on it saves a valid number or a preset, off it goes back to any size', async () => {
  const store = render({ tokens: null, moments: ['turn-end'] });
  await flip('auto-compact-threshold', true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 200_000, moments: ['turn-end'] } });
  const type = async (value: string) => {
    const field = input('auto-compact-tokens');
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };
  const calls = store.saveSettings.mock.calls.length;
  await type('500');
  expect(store.saveSettings.mock.calls.length).toBe(calls);
  expect(document.querySelector('[data-testid="auto-compact-tokens-error"]')).not.toBeNull();
  await type('350000');
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 350_000, moments: ['turn-end'] } });
  input('auto-compact-preset-400000').click();
  await settle();
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 400_000, moments: ['turn-end'] } });
  expect(input('auto-compact-tokens').value).toBe('400000');

  await flip('auto-compact-threshold', false);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: null, moments: ['turn-end'] } });
  await flip('auto-compact-threshold', true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 400_000, moments: ['turn-end'] } });
});
