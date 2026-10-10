import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FirewallStatus } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import PairingCard from './PairingCard.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const blocked: FirewallStatus = { state: 'blocked', networks: ['public'], allowed: [], blocked: ['public'] };
const ready: FirewallStatus = { state: 'ready', networks: ['public'], allowed: ['public'], blocked: [] };

function card(allow: () => FirewallStatus) {
  const call = vi.fn(async (method: string) => (method === 'firewall.allow' ? allow() : blocked));
  const store = $state({
    owner: true,
    principal: 'owner',
    connection: 'ready',
    pairing: null,
    sessions: [],
    settings: { listenOnLan: false, publicUrl: null },
    client: { call },
    loadSessions: vi.fn(async () => {}),
    saveSettings: vi.fn(async (patch: { listenOnLan?: boolean }) => {
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(PairingCard, { target: document.body, props: { store: store as unknown as Store } });
  return { call, store };
}

test('turning the local network on asks Windows for the firewall rule at once', async () => {
  const { call } = card(() => ready);
  await settle();
  expect(call).not.toHaveBeenCalled();
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
