import { afterEach, expect } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    flushSync();
  }
}

test('the two-choice control saves local mode, shows Douane running, and Stop and Start drive it', async ({ ready }) => {
  const { store } = await ready({ delayMs: 0 });
  mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
  flushSync();
  expect(q('subscription-proxy-remote')?.getAttribute('aria-pressed')).toBe('true');
  expect(q('subscription-proxy-url')).not.toBeNull();

  q('subscription-proxy-local')!.click();
  flushSync();
  // Local mode asks for no address or key: the core writes them.
  expect(q('subscription-proxy-url')).toBeNull();
  expect(q('subscription-proxy-key')).toBeNull();
  expect(q('douane-local')).toBeNull();
  q('subscription-proxy-enabled')!.click();
  q('subscription-proxy-save')!.click();
  await until(() => store.settings?.subscriptionProxy?.mode === 'local', 'local mode saved');
  expect(store.settings?.subscriptionProxy).toMatchObject({ enabled: true, kind: 'douane', baseUrl: 'http://127.0.0.1:8787/v1', dashboardUrl: 'http://127.0.0.1:8787/admin/' });

  await until(() => q('douane-local')?.dataset.state === 'running', 'Douane running');
  expect(q('douane-local-state')?.textContent).toBe('Running');
  expect(q('douane-local-version')?.textContent).toBe('Version 0.3.0, 0.3.1 available');
  expect(q('douane-local-update')).not.toBeNull();

  q('douane-local-stop')!.click();
  await until(() => q('douane-local')?.dataset.state === 'stopped', 'Douane stopped');
  q('douane-local-start')!.click();
  await until(() => q('douane-local')?.dataset.state === 'running', 'Douane running again');

  // Back to a remote gateway: Douane goes off, the remote form is back.
  q('subscription-proxy-remote')!.click();
  flushSync();
  expect(q<HTMLInputElement>('subscription-proxy-url')?.value).toBe('http://127.0.0.1:8787');
  q('subscription-proxy-save')!.click();
  await until(() => store.douane?.state === 'off', 'Douane off');
  expect(store.settings?.subscriptionProxy?.mode).toBe('remote');
  expect(q('douane-local')).toBeNull();
});

test('a paired device sees the state without Start, Stop, Update or Save', async ({ ready }) => {
  const { store } = await ready({ delayMs: 0, principal: 'session' });
  expect(store.owner).toBe(false);
  store.settings = { ...store.settings!, subscriptionProxy: { enabled: true, kind: 'douane', mode: 'local', baseUrl: 'http://127.0.0.1:8787/v1', dashboardUrl: 'http://127.0.0.1:8787/admin/' } };
  store.douane = { state: 'running', version: '0.3.0', available: '0.3.1', port: 8787 };
  mounted = mount(SubscriptionProxySettings, { target: document.body, props: { store } });
  flushSync();
  expect(q('douane-local-state')?.textContent).toBe('Running');
  expect(q('douane-local-stop')).toBeNull();
  expect(q('douane-local-update')).toBeNull();
  expect(q<HTMLButtonElement>('subscription-proxy-save')?.disabled).toBe(true);
});
