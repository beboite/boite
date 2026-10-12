import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FirewallStatus } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import PhoneSettings from './PhoneSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const blocked: FirewallStatus = { state: 'blocked', networks: ['public'], allowed: [], blocked: ['public'] };
const ready: FirewallStatus = { state: 'ready', networks: ['public'], allowed: ['public'], blocked: [] };
const tailscaleOff = { state: 'off', dnsName: null, url: null, servedTarget: null, target: 'http://127.0.0.1:7337', publicUrlMatches: false };

/** The Phone card, where the local network switch lives, on an owner's core whose firewall blocks phones. */
function card(allow: () => FirewallStatus) {
  const call = vi.fn(async (method: string) => (method === 'firewall.allow' ? allow() : method === 'tailscale.status' ? tailscaleOff : blocked));
  const store = $state({
    owner: true,
    principal: 'owner',
    connection: 'ready',
    endpointUrl: null,
    deviceInvite: null,
    sessions: [],
    settings: { listenOnLan: false, publicUrl: null },
    client: { call },
    addDevice: vi.fn(async () => {}),
    saveSettings: vi.fn(async (patch: { listenOnLan?: boolean }) => {
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(PhoneSettings, { target: document.body, props: { store: store as unknown as Store } });
  return { call, store };
}

test('turning the local network on asks Windows for the firewall rule at once', async () => {
  const { call } = card(() => ready);
  await settle();
  expect(call.mock.calls.map(([method]) => method)).not.toContain('firewall.allow');
  document.querySelector<HTMLInputElement>('[data-testid=setting-listen-on-lan]')!.click();
  await settle();
  expect(call.mock.calls.map(([method]) => method)).toContain('firewall.allow');
  expect(document.querySelector('[data-testid=firewall-notice]')).toBeNull();
  expect(document.querySelector('[data-testid=firewall-allowed]')).not.toBeNull();
});

test('a refused administrator prompt leaves the block named, with the button to try again', async () => {
  const { call } = card(() => ({ ...blocked, detail: 'cancelled' }));
  document.querySelector<HTMLInputElement>('[data-testid=setting-listen-on-lan]')!.click();
  await settle();
  const notice = document.querySelector<HTMLElement>('[data-testid=firewall-notice]')!;
  expect(notice.dataset.state).toBe('blocked');
  expect(notice.textContent).toContain('public');
  expect(document.querySelector('[data-testid=firewall-outcome]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid=firewall-allow]')!.click();
  await settle();
  expect(call.mock.calls.filter(([method]) => method === 'firewall.allow')).toHaveLength(2);
});

test('an unreadable firewall says so, and claims no refused change nor offers the button', async () => {
  const unreadable: FirewallStatus = { state: 'error', networks: [], allowed: [], blocked: [], detail: 'timeout' };
  const call = vi.fn(async (method: string) => (method === 'tailscale.status' ? tailscaleOff : unreadable));
  const store = $state({
    owner: true, principal: 'owner', connection: 'ready', endpointUrl: null, deviceInvite: null, sessions: [],
    settings: { listenOnLan: true, publicUrl: null }, client: { call },
    addDevice: vi.fn(async () => {}), saveSettings: vi.fn(async () => true),
  });
  mounted = mount(PhoneSettings, { target: document.body, props: { store: store as unknown as Store } });
  await settle();
  const notice = document.querySelector<HTMLElement>('[data-testid=firewall-notice]')!;
  expect(notice.dataset.state).toBe('error');
  expect(document.querySelector('[data-testid=firewall-outcome]')).toBeNull();
  expect(document.querySelector('[data-testid=firewall-allow]')).toBeNull();
});
