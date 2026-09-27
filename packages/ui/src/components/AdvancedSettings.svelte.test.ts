import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Store } from '../lib/store.svelte';
import AdvancedSettings from './AdvancedSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const base = { maxConcurrentTurns: 4, perAccountConcurrency: 2, warmProcessMinutes: 5 };

test('an origins draft survives a settings update from elsewhere, and a save lets the saved list back in', async () => {
  const store = $state({
    owner: true,
    core: null,
    connection: 'ready',
    settings: { ...base, browserOrigins: ['https://a.test'] },
    saveSettings: vi.fn(async (patch: { browserOrigins?: string[] }) => {
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(AdvancedSettings, { target: document.body, props: { store: store as unknown as Store } });
  await settle();
  const field = document.querySelector<HTMLTextAreaElement>('[data-testid=browser-origins] textarea')!;
  expect(field.value).toBe('https://a.test');

  field.value = 'https://a.test\nhttps://b.test';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  // Another client saves the origins while this one is being typed.
  store.settings = { ...store.settings, browserOrigins: ['https://z.test'] };
  await settle();
  expect(field.value).toBe('https://a.test\nhttps://b.test');

  document.querySelector<HTMLButtonElement>('[data-testid=browser-origins] > button')!.click();
  await settle();
  expect(store.saveSettings).toHaveBeenCalledWith({ browserOrigins: ['https://a.test', 'https://b.test'] });
  store.settings = { ...store.settings, browserOrigins: ['https://c.test'] };
  await settle();
  expect(field.value).toBe('https://c.test');
});
