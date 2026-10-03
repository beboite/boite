import { afterEach, expect } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import PhoneSettings from './PhoneSettings.svelte';

let component: Record<string, unknown> | null = null;

afterEach(() => {
  if (component) unmount(component, { outro: false });
  component = null;
  document.body.innerHTML = '';
});

test('an address being typed survives another setting, and follows a new saved one', async ({ store }) => {
  component = mount(PhoneSettings, { target: document.body, props: { store } });
  flushSync();
  const field = document.querySelector<HTMLInputElement>('[data-testid=phone-public-url]')!;
  field.value = 'https://typing.test';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  // Any update replaces the whole settings object.
  store.settings = { ...store.settings!, publicUrl: store.settings?.publicUrl ?? null };
  flushSync();
  expect(field.value).toBe('https://typing.test');

  store.settings = { ...store.settings!, publicUrl: 'https://saved.test' };
  flushSync();
  expect(field.value).toBe('https://saved.test');
});
