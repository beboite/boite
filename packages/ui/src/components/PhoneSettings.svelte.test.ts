import { afterEach, expect } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import PhoneSettings from './PhoneSettings.svelte';
import { strings } from '../lib/strings';

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

test('a machine carried by the one that serves this page sends its notifications through it; one carried by another does not', async ({ store }) => {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  try {
    store.endpointUrl = `${window.location.origin}/group/relay/${'c'.repeat(64)}`;
    component = mount(PhoneSettings, { target: document.body, props: { store } });
    flushSync();
    expect(document.querySelector('[data-testid=phone-relayed]')).not.toBeNull();
    unmount(component, { outro: false });
    // Carried by a machine of another origin: this page installed nothing there, and nothing comes through it.
    store.endpointUrl = `https://other.example/group/relay/${'c'.repeat(64)}`;
    component = mount(PhoneSettings, { target: document.body, props: { store } });
    flushSync();
    expect(document.querySelector('[data-testid=phone-relayed]')).toBeNull();
    expect(document.body.textContent).toContain(strings.phone.ownOrigin);
  } finally {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
});
