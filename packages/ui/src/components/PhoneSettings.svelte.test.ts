import { afterEach, expect, vi } from 'vitest';
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

test('the phone screen turns notifications and each kind on and off, and a device with push tells its core', async ({ store }) => {
  localStorage.clear();
  localStorage.setItem('boite.web-push', 'on');
  const calls: unknown[] = [];
  const call = store.client!.call.bind(store.client!);
  store.client!.call = (async (method: string, params: unknown) => {
    if (method === 'push.kinds') { calls.push(params); return { ok: true }; }
    return call(method as never, params as never);
  }) as typeof call;
  try {
    component = mount(PhoneSettings, { target: document.body, props: { store, showServerSettings: false } });
    flushSync();
    const kind = (name: string) => document.querySelector<HTMLInputElement>(`[data-testid=setting-notification-kind-${name}]`)!;
    expect(['approvals', 'questions', 'finished', 'errors', 'limits'].map((name) => kind(name).checked)).toEqual([true, true, true, true, true]);
    kind('finished').click();
    flushSync();
    expect(kind('finished').checked).toBe(false);
    expect(JSON.parse(localStorage.getItem('boite.notifications.muted')!)).toEqual(['finished']);
    expect(calls.at(-1)).toEqual({ kinds: ['approvals', 'questions', 'errors', 'limits'] });
    // The main switch off dims the kinds and stops the pushes too.
    document.querySelector<HTMLInputElement>('[data-testid=phone-notifications]')!.click();
    flushSync();
    expect(kind('approvals').disabled).toBe(true);
    expect(calls.at(-1)).toEqual({ kinds: [] });
  } finally {
    localStorage.clear();
  }
});

test('an address typed while the previous one is saving is the one saved next, and stays in the field', async ({ store }) => {
  component = mount(PhoneSettings, { target: document.body, props: { store } });
  flushSync();
  const client = store.client!;
  const call = client.call.bind(client);
  const sent: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  client.call = (async (method: string, params: { publicUrl?: string | null }) => {
    if (method === 'settings.set' && 'publicUrl' in params) {
      sent.push(params.publicUrl);
      if (sent.length === 1) await held;
    }
    return call(method as never, params as never);
  }) as typeof client.call;
  const field = document.querySelector<HTMLInputElement>('[data-testid=phone-public-url]')!;
  const type = (value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
  };
  type('https://first.test');
  await Promise.resolve();
  type('https://second.test');
  release();
  await vi.waitFor(() => expect(store.settings?.publicUrl).toBe('https://second.test'));
  flushSync();
  expect(sent).toEqual(['https://first.test', 'https://second.test']);
  expect(field.value).toBe('https://second.test');
});
