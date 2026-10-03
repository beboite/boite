import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Store } from '../lib/store.svelte';
import SubscriptionProxyDashboard from './SubscriptionProxyDashboard.svelte';

const bridge = vi.hoisted(() => ({ paints: false, create: vi.fn(), destroy: vi.fn(), reload: vi.fn(), on: () => () => {} }));
vi.mock('../lib/browser-bridge', () => ({ browserBridge: bridge }));
vi.mock('../lib/browser-bounds', () => ({ watchBrowserBounds: () => () => {} }));
vi.mock('../lib/browser-presentation', () => ({ browserPresentation: () => ({}) }));
let app: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (app) await unmount(app); app = undefined; document.body.innerHTML = ''; bridge.paints = false; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function show(url: string) {
  const store = { owner: false, settings: { subscriptionProxy: { enabled: true, dashboardUrl: url } } } as unknown as Store;
  app = mount(SubscriptionProxyDashboard, { target: document.body, props: { store } });
  flushSync();
}

test('HTTPS browser refuses an HTTP frame before creating it and offers the external dashboard', () => {
  vi.stubGlobal('location', { protocol: 'https:' });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  show('http://gateway.test/admin/#quotas');
  expect(document.querySelector('iframe')).toBeNull();
  expect(bridge.create).not.toHaveBeenCalled();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('HTTPS dashboard URL');
  document.querySelector<HTMLButtonElement>('[data-testid=subscription-proxy-open]')!.click();
  expect(open).toHaveBeenCalledWith('http://gateway.test/admin/#quotas', '_blank', 'noopener,noreferrer');
});

test('production browser embeds an HTTPS dashboard and gives login and reload actions', () => {
  vi.stubGlobal('location', { protocol: 'https:' });
  show('https://gateway.test/admin/#quotas');
  const frame = document.querySelector('iframe')!;
  expect(frame.src).toBe('https://gateway.test/admin/#quotas');
  expect(bridge.create).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid=subscription-proxy-browser-hint]')?.textContent).toContain('Sign in');
  frame.src = 'https://gateway.test/login';
  document.querySelector<HTMLButtonElement>('[data-testid=subscription-proxy-reload]')!.click();
  expect(frame.src).toBe('https://gateway.test/admin/#quotas');
});

test('native shell keeps its child webview and destroys it on exit', async () => {
  vi.stubGlobal('location', { protocol: 'https:' });
  bridge.paints = true;
  show('http://gateway.test/admin/#quotas');
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('[data-testid=subscription-proxy-browser-hint]')).toBeNull();
  expect(bridge.create).toHaveBeenCalledWith(expect.stringMatching(/^subscription-proxy:/), 'http://gateway.test/admin/#quotas');
  document.querySelector<HTMLButtonElement>('[data-testid=subscription-proxy-reload]')!.click();
  expect(bridge.reload).toHaveBeenCalledTimes(1);
  await unmount(app!); app = undefined;
  expect(bridge.destroy).toHaveBeenCalledTimes(1);
});
