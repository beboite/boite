import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FirewallStatus, PairingGrant } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import PairingCard from './PairingCard.svelte';
import { isLoopback } from './LanReach.svelte';

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
const grant = (host: string): PairingGrant => ({ url: `http://${host}:7337/?grant=g`, grant: 'g', role: 'device', expiresAt: Date.now() + 600_000, code: 'K7QM-2222' });

/** The desktop app's own core, which listens on itself until the setting is on and a restart applied it. */
function card(localCore = true) {
  let listening = false;
  let allowed = false;
  const calls: string[] = [];
  const store = $state({
    owner: true, principal: 'owner', connection: 'ready', localCore, sessions: [],
    pairing: grant('127.0.0.1') as PairingGrant | null,
    settings: { listenOnLan: false, publicUrl: null },
    core: { endpoint: { host: '127.0.0.1', port: 7337 } },
    client: {
      call: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === 'core.restart') { listening = store.settings.listenOnLan; return { ok: true }; }
        if (method === 'firewall.allow') allowed = true;
        return allowed ? ready : unset;
      }),
    },
    loadSessions: vi.fn(async () => {}),
    mintPairing: vi.fn(async () => { store.pairing = grant(listening ? '192.168.1.52' : '127.0.0.1'); }),
    saveSettings: vi.fn(async (patch: { listenOnLan?: boolean }) => { store.settings = { ...store.settings, ...patch }; return true; }),
  });
  mounted = mount(PairingCard, { target: document.body, props: { store: store as unknown as Store } });
  return { store, calls };
}

test('a loopback link shows no QR code, and the button turns the network on, restarts, and shows a link a phone reaches', async () => {
  const { store, calls } = card();
  await settle();
  expect(document.querySelector('[data-testid=pairing-qr]')).toBeNull();
  expect(document.querySelector('[data-testid=pairing-code]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid=lan-reach-button]')!.click();
  await settle();
  expect(store.settings.listenOnLan).toBe(true);
  expect(calls).toEqual(expect.arrayContaining(['firewall.allow', 'core.restart']));
  expect(document.querySelector('[data-testid=lan-reach]')?.getAttribute('data-phase')).toBe('restarting');
  await vi.advanceTimersByTimeAsync(1600);
  await settle();
  expect(store.pairing?.url).toBe('http://192.168.1.52:7337/?grant=g');
  expect(document.querySelector('[data-testid=lan-reach]')).toBeNull();
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

test('turning the network off with an owner link on show restarts, keeps the owner role and settles on loopback, through a failed mint', async () => {
  let listening = true;
  let failOnce = true;
  const roles: string[] = [];
  const ownerGrant = (host: string): PairingGrant => ({ ...grant(host), role: 'owner' });
  const store = $state({
    owner: true, principal: 'owner', connection: 'ready', localCore: true, sessions: [],
    pairing: ownerGrant('192.168.1.52') as PairingGrant | null,
    settings: { listenOnLan: true, publicUrl: null },
    core: { endpoint: { host: '0.0.0.0', port: 7337 } },
    client: { call: vi.fn(async (method: string) => { if (method === 'core.restart') listening = store.settings.listenOnLan; return ready; }) },
    loadSessions: vi.fn(async () => {}),
    mintPairing: vi.fn(async (role: string) => {
      roles.push(role);
      if (failOnce) { failOnce = false; throw new Error('connection lost'); }
      store.pairing = ownerGrant(listening ? '192.168.1.52' : '127.0.0.1');
    }),
    saveSettings: vi.fn(async (patch: { listenOnLan?: boolean }) => { store.settings = { ...store.settings, ...patch }; return true; }),
  });
  mounted = mount(PairingCard, { target: document.body, props: { store: store as unknown as Store } });
  await settle();
  (document.querySelector('[data-testid=pairing-options]') as HTMLDetailsElement).open = true;
  const lan = document.querySelector<HTMLInputElement>('[data-testid=setting-listen-on-lan]')!;
  lan.click();
  await settle();
  expect(store.settings.listenOnLan).toBe(false);
  // A second flip while the core restarts would be saved and never applied.
  expect(lan.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1600);
  await settle();
  await vi.advanceTimersByTimeAsync(1600);
  await settle();
  expect(roles).toEqual(['owner', 'owner']);
  expect(store.pairing?.url.startsWith('http://127.0.0.1:')).toBe(true);
  expect(document.querySelector('[data-testid=lan-reach]')?.getAttribute('data-phase')).toBe('idle');
  expect(lan.disabled).toBe(false);
});
