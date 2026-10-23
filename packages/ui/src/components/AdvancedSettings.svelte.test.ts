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
const base = { warmProcessMinutes: 5 };

test('an origins draft survives a settings update from elsewhere, and saving it lets the saved list back in', async () => {
  const store = $state({
    owner: true,
    core: null,
    client: null,
    endpointUrl: null,
    sessions: [],
    deviceInvite: null,
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

  // Leaving the field saves what it holds, with no Save button.
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(store.saveSettings).toHaveBeenCalledWith({ browserOrigins: ['https://a.test', 'https://b.test'] });
  store.settings = { ...store.settings, browserOrigins: ['https://c.test'] };
  await settle();
  expect(field.value).toBe('https://c.test');
});

test('an origin being typed is not sent until it is a valid origin, and a refused save says so', async () => {
  let refuse = false;
  const store = $state({
    owner: true,
    core: null,
    client: null,
    endpointUrl: null,
    sessions: [],
    deviceInvite: null,
    connection: 'ready',
    settings: { ...base, browserOrigins: [] as string[] },
    saveSettings: vi.fn(async (patch: { browserOrigins?: string[] }) => {
      if (refuse) return false;
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(AdvancedSettings, { target: document.body, props: { store: store as unknown as Store } });
  await settle();
  const field = document.querySelector<HTMLTextAreaElement>('[data-testid=browser-origins] textarea')!;
  const status = () => document.querySelector<HTMLElement>('[data-testid=browser-origins] [data-testid=save-status]');
  const type = async (value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };
  await type('boite.exa');
  expect(status()?.dataset.state).toBe('invalid');
  expect(store.saveSettings).not.toHaveBeenCalled();
  refuse = true;
  await type('https://boite.example.com');
  expect(status()?.dataset.state).toBe('error');
  expect(store.settings.browserOrigins).toEqual([]);
  refuse = false;
  status()!.querySelector('button')!.click();
  await settle();
  expect(status()?.dataset.state).toBe('saved');
  expect(store.settings.browserOrigins).toEqual(['https://boite.example.com']);
});
