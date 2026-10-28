import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';
import { phoneWidth } from '../test/phone-width';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);

test('the plugin choice saves local mode at the Douane plugin\'s port and says it runs', async ({ ready }) => {
  const { store } = await ready({ delayMs: 0 });
  mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
  flushSync();
  expect(q('subscription-proxy-remote')?.getAttribute('aria-pressed')).toBe('true');
  expect(q('subscription-proxy-url')).not.toBeNull();

  q('subscription-proxy-local')!.click();
  flushSync();
  // The plugin's URLs come from the core: no address or key to type.
  expect(q('subscription-proxy-url')).toBeNull();
  expect(q('subscription-proxy-key')).toBeNull();
  await vi.waitFor(() => expect(q('subscription-proxy-plugin')?.dataset.state).toBe('running'));
  expect(q('subscription-proxy-plugin')?.textContent).toContain('Douane 0.3.0 answers on 127.0.0.1:8787.');
  expect(q('subscription-proxy-open-plugins')).toBeNull();

  q('subscription-proxy-enabled')!.click();
  q('subscription-proxy-save')!.click();
  await vi.waitFor(() => expect(store.settings?.subscriptionProxy?.mode).toBe('local'));
  expect(store.settings?.subscriptionProxy).toMatchObject({ enabled: true, kind: 'douane', baseUrl: 'http://127.0.0.1:8787/v1', dashboardUrl: 'http://127.0.0.1:8787/admin/' });

  // Back to a remote gateway: the address typed before is there again.
  q('subscription-proxy-remote')!.click();
  flushSync();
  expect(q<HTMLInputElement>('subscription-proxy-url')?.value).toBe('http://127.0.0.1:8787');
});

test('on a phone, which leaves Plugins to the desktop, the card says the plugin is missing and leads nowhere', async ({ ready }) => {
  const restore = phoneWidth();
  try {
    const { store, client } = await ready({ delayMs: 0 });
    await client.call('plugins.uninstall', { id: 'douane' });
    mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
    flushSync();
    q('subscription-proxy-local')!.click();
    await vi.waitFor(() => expect(q('subscription-proxy-plugin')?.dataset.state).toBe('missing'));
    expect(q('subscription-proxy-open-plugins')).toBeNull();
  } finally {
    restore();
  }
});

test('without the plugin installed the card says so and leads to Plugins', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  await client.call('plugins.uninstall', { id: 'douane' });
  const show = vi.spyOn(store, 'showSettings');
  mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
  flushSync();
  q('subscription-proxy-local')!.click();
  await vi.waitFor(() => expect(q('subscription-proxy-plugin')?.dataset.state).toBe('missing'));
  expect(q('subscription-proxy-plugin')?.textContent).toContain('The Douane plugin is not installed on this machine.');
  q('subscription-proxy-open-plugins')!.click();
  expect(show).toHaveBeenCalledWith('plugins');
});
