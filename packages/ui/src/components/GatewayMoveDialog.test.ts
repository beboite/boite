import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { SubscriptionProxy } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { besideCore, gatewayDashboard } from '../lib/gateway-dashboard';
import { Store } from '../lib/store.svelte';
import GatewayOpenButton from './GatewayOpenButton.svelte';
import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let detach: (() => void) | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined; detach?.(); detach = undefined;
  document.body.innerHTML = ''; vi.restoreAllMocks();
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const proxy = (baseUrl: string): SubscriptionProxy => ({ enabled: true, kind: 'douane', baseUrl, dashboardUrl: `${baseUrl}/admin/#quotas` });
const $ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);

async function owner(baseUrl: string): Promise<Store> {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: proxy(baseUrl) });
  detach = () => { store.detach(); client.close(); };
  return store;
}

test('a loopback dashboard opens only beside the core; a remote one opens anywhere', () => {
  const loopback = (localCore: boolean, endpointUrl: string | null) => ({ settings: { subscriptionProxy: proxy('http://127.0.0.1:8787') }, localCore, endpointUrl }) as unknown as Store;
  expect(gatewayDashboard(loopback(true, null))).toBe('http://127.0.0.1:8787/admin/#quotas');
  // A browser reaching its core at a loopback address is on the same machine.
  expect(besideCore({ localCore: false, endpointUrl: 'http://127.0.0.1:3773' })).toBe(true);
  // A phone or another computer reaching the core over the network is not.
  expect(gatewayDashboard(loopback(false, 'https://boite.example.test'))).toBeNull();
  expect(gatewayDashboard({ settings: { subscriptionProxy: proxy('http://[::1]:8787') }, localCore: false, endpointUrl: 'http://100.64.0.15:3773' } as unknown as Store)).toBeNull();
  expect(gatewayDashboard({ settings: { subscriptionProxy: proxy('https://douane.example.test') }, localCore: false, endpointUrl: 'https://boite.example.test' } as unknown as Store))
    .toBe('https://douane.example.test/admin/#quotas');
});

test('Open Douane names the gateway, opens it in the browser, and is absent on a phone for a loopback dashboard', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  mounted = mount(GatewayOpenButton, { target: document.body, props: { store: { settings: { subscriptionProxy: proxy('https://douane.example.test') }, localCore: false, endpointUrl: 'https://boite.example.test' } as unknown as Store } });
  flushSync();
  expect($('subscription-proxy-open')!.textContent).toBe('Open Douane');
  $<HTMLButtonElement>('subscription-proxy-open')!.click();
  expect(open).toHaveBeenCalledWith('https://douane.example.test/admin/#quotas', '_blank', 'noopener,noreferrer');
  void unmount(mounted); flushSync();
  mounted = mount(GatewayOpenButton, { target: document.body, props: { store: { settings: { subscriptionProxy: { ...proxy('http://127.0.0.1:8317'), kind: 'cliproxyapi' } }, localCore: false, endpointUrl: 'https://boite.example.test' } as unknown as Store } });
  flushSync();
  expect($('subscription-proxy-open')).toBeNull();
});

test('the move dialog lists what can move, says why the rest cannot, and shows each line\'s result', async () => {
  const store = await owner('http://127.0.0.1:8787');
  mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
  await settle();
  $<HTMLButtonElement>('gateway-move-open')!.click();
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="gateway-move-row"]').length).toBeGreaterThan(3));
  const dialog = $('gateway-move-dialog')!;
  expect(dialog.textContent).toContain('this machine\'s copy stops working');
  expect(dialog.textContent).toContain('http://127.0.0.1:8787');
  const row = (id: string) => dialog.querySelector<HTMLElement>(`[data-testid="gateway-move-row"][data-id="${id}"]`)!;
  expect(row('a-opencode:key:deepseek').textContent).toContain('DeepSeek API key');
  expect(row('a-opencode:key:opencode').textContent).toContain('served as zen');
  expect(row('a-opencode:key:groq').textContent).toContain('No known API address');
  expect(row('a-opencode:key:groq').querySelector('input')!.disabled).toBe(true);
  expect(row('a-claude-side:login').textContent).toContain('Not signed in');

  // Unticked lines stay where they are.
  row('a-opencode:copilot').querySelector('input')!.click();
  await settle();
  const button = $<HTMLButtonElement>('gateway-move-confirm')!;
  const count = Number(/\d+/.exec(button.textContent!)![0]);
  button.click();
  await vi.waitFor(() => expect(row('a-opencode:key:deepseek').textContent).toContain('Moved'));
  expect(row('a-opencode:key:opencode').textContent).toContain('Refused: upstream answered HTTP 401');
  expect(row('a-opencode:copilot').querySelector('[data-testid="gateway-move-status"]')).toBeNull();
  expect(count).toBeGreaterThan(2);
  // What moved cannot be sent twice; the refused line can be tried again.
  expect($('gateway-move-confirm')!.textContent).toBe('Move 1');
  $<HTMLButtonElement>('gateway-move-close')!.click();
  await settle();
});

test('a remote Douane that wants a management token says so, and the token entered here is used', async () => {
  const store = await owner('https://douane.example.test');
  mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
  await settle();
  $<HTMLButtonElement>('gateway-move-open')!.click();
  await vi.waitFor(() => expect($('gateway-move-confirm')!.hasAttribute('disabled')).toBe(false));
  $<HTMLButtonElement>('gateway-move-confirm')!.click();
  await vi.waitFor(() => expect($('gateway-move-error')!.textContent).toContain('enter its management token'));
  const token = $<HTMLInputElement>('gateway-move-token')!;
  token.value = 'management-secret';
  token.dispatchEvent(new Event('input', { bubbles: true }));
  $<HTMLButtonElement>('gateway-move-confirm')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Moved'));
  expect($('gateway-move-error')).toBeNull();
  expect(token.value).toBe('');
  expect(document.body.textContent).toContain('A management token is saved');
});

test('the move is offered for a saved Douane only, never for CLIProxyAPI', async () => {
  const store = await owner('http://127.0.0.1:8787');
  store.settings = await store.client!.call('subscriptionProxy.configure', { subscriptionProxy: { ...proxy('http://127.0.0.1:8317'), kind: 'cliproxyapi' } });
  mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
  await settle();
  expect($('gateway-move-open')).toBeNull();
  expect($('subscription-proxy-open')!.textContent).toBe('Open CLIProxyAPI');
});
