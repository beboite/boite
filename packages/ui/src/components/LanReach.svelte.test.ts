import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { DeviceInvite, FirewallStatus } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import AddDevice from './AddDevice.svelte';
import PhoneSettings from './PhoneSettings.svelte';
import { isLoopback } from './LanReach.svelte';
import { strings } from '../lib/strings';

let mounted: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  window.__TAURI_INTERNALS__ = {};
});
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  delete window.__TAURI_INTERNALS__;
  vi.useRealTimers();
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const ready: FirewallStatus = { state: 'ready', networks: ['public'], allowed: ['public'], blocked: [] };
const unset: FirewallStatus = { state: 'unset', networks: ['public'], allowed: [], blocked: [] };
const invite = (origin: string): DeviceInvite => ({ url: `${origin}/?grant=g#join=boite-invite`, expiresAt: Date.now() + 600_000 });
const tailscaleOff = { state: 'off', dnsName: null, url: null, servedTarget: null, target: 'http://127.0.0.1:7337', publicUrlMatches: false };

/** "Add a device" on the desktop app's own core, which listens on itself until the setting is on and a restart applied it. */
function card(localCore = true) {
  let listening = false;
  let allowed = false;
  const calls: string[] = [];
  const store = $state({
    owner: true, principal: 'owner', connection: 'ready', localCore, sessions: [],
    deviceInvite: invite('http://127.0.0.1:7337') as DeviceInvite | null,
    settings: { listenOnLan: false, publicUrl: null },
    core: { endpoint: { host: '127.0.0.1', port: 7337 } },
    client: {
      call: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === 'core.restart') { listening = store.settings.listenOnLan; store.core = { endpoint: { host: listening ? '0.0.0.0' : '127.0.0.1', port: 7337 } }; return { ok: true }; }
        if (method === 'firewall.allow') allowed = true;
        return allowed ? ready : unset;
      }),
    },
    addDevice: vi.fn(async () => { store.deviceInvite = invite(listening ? 'http://192.168.1.52:7337' : 'http://127.0.0.1:7337'); }),
    closeDeviceInvite: vi.fn(() => { store.deviceInvite = null; }),
    saveSettings: vi.fn(async (patch: { listenOnLan?: boolean }) => { store.settings = { ...store.settings, ...patch }; return true; }),
  });
  mounted = mount(AddDevice, { target: document.body, props: { store: store as unknown as Store } });
  return { store, calls };
}

test('a loopback link shows no QR code, and the button turns the network on, restarts, and shows a link a phone reaches', async () => {
  const { store, calls } = card();
  await settle();
  expect(document.querySelector('[data-testid=add-device]')).not.toBeNull();
  expect(document.querySelector('[data-testid=add-device-qr]')).toBeNull();
  // Nothing tells a phone to scan a link that would name the phone itself.
  expect(document.querySelector('[data-testid=add-device]')?.textContent).not.toContain(strings.group.scanTitle);
  document.querySelector<HTMLButtonElement>('[data-testid=lan-reach-button]')!.click();
  await settle();
  expect(store.settings.listenOnLan).toBe(true);
  expect(calls).toEqual(expect.arrayContaining(['firewall.allow', 'core.restart']));
  expect(document.querySelector('[data-testid=lan-reach]')?.getAttribute('data-phase')).toBe('restarting');
  await vi.advanceTimersByTimeAsync(1600);
  await settle();
  expect(store.deviceInvite?.url).toBe('http://192.168.1.52:7337/?grant=g#join=boite-invite');
  expect(document.querySelector('[data-testid=lan-reach]')).toBeNull();
  expect(document.querySelector('[data-testid=add-device]')?.textContent).toContain(strings.group.scanTitle);
});

test('a core the desktop app did not start keeps the manual hint and no button', async () => {
  card(false);
  await settle();
  expect(document.querySelector('[data-testid=lan-reach-button]')).toBeNull();
  expect(document.querySelector('[data-testid=lan-reach]')?.textContent).toContain('restarted');
});

test('isLoopback names the links that only reach the computer opening them', () => {
  expect(['http://127.0.0.1:7337/?grant=a', 'http://localhost:7337/', 'http://[::1]:7337/'].every(isLoopback)).toBe(true);
  expect(['http://192.168.1.52:7337/?grant=a', 'https://boite.example.com/', 'not a url'].some(isLoopback)).toBe(false);
});

test('turning the network off restarts, settles on the bound address and draws the Add a device link again, even behind a public address', async () => {
  const store = $state({
    owner: true, principal: 'owner', connection: 'ready', localCore: true, sessions: [], endpointUrl: null,
    // A public address: the link names neither loopback nor the LAN, whatever the core listens on.
    deviceInvite: invite('https://boite.example.com') as DeviceInvite | null,
    settings: { listenOnLan: true, publicUrl: 'https://boite.example.com' },
    core: { endpoint: { host: '0.0.0.0', port: 7337 } },
    client: { call: vi.fn(async (method: string) => {
      if (method === 'core.restart') {
        // The old core answers through its grace; the next one comes back bound as the setting says.
        setTimeout(() => { store.core = { endpoint: { host: store.settings.listenOnLan ? '0.0.0.0' : '127.0.0.1', port: 7337 } }; }, 2000);
      }
      return method === 'tailscale.status' ? tailscaleOff : ready;
    }) },
    // Pairing.addDevice never throws: a failure becomes the store's error.
    addDevice: vi.fn(async () => { store.deviceInvite = invite('https://boite.example.com'); }),
    saveSettings: vi.fn(async (patch: { listenOnLan?: boolean }) => { store.settings = { ...store.settings, ...patch }; return true; }),
  });
  mounted = mount(PhoneSettings, { target: document.body, props: { store: store as unknown as Store } });
  await settle();
  const lan = document.querySelector<HTMLInputElement>('[data-testid=setting-listen-on-lan]')!;
  lan.click();
  await settle();
  expect(store.settings.listenOnLan).toBe(false);
  // A second flip while the core restarts would be saved and never applied.
  expect(lan.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1600);
  await settle();
  expect(store.addDevice).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1600);
  await settle();
  expect(store.addDevice).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid=lan-reach]')).toBeNull();
  expect(lan.disabled).toBe(false);
});
