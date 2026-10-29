import { expect, vi } from 'vitest';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('Add a device can be closed and a fresh link drawn', async ({ app: _app }) => {
  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=group-add-device]') !== null);
  query<HTMLButtonElement>('[data-testid=group-add-device]').click();
  await waitFor(() => document.querySelector('[data-testid=add-device]') !== null);
  const first = store.deviceInvite!.url;
  query<HTMLButtonElement>('[data-testid=add-device-close]').click();
  await waitFor(() => document.querySelector('[data-testid=add-device]') === null);
  expect(store.deviceInvite).toBeNull();
  query<HTMLButtonElement>('[data-testid=group-add-device]').click();
  await waitFor(() => document.querySelector('[data-testid=add-device]') !== null);
  expect(store.deviceInvite!.url).not.toBe(first);
});

test('Add a device draws one QR code of the phone part, with no code to type', async ({ app: _app }) => {
  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=group-add-device]') !== null);
  query<HTMLButtonElement>('[data-testid=group-add-device]').click();
  await waitFor(() => document.querySelector('[data-testid=add-device-qr] svg') !== null);
  expect(document.querySelector('[data-testid=add-device-code]')).toBeNull();
  // The phone's link and the invitation a computer joins with: one link, copied whole.
  expect(store.deviceInvite!.url).toMatch(/^http:\/\/192\.168\.1\.20:8777\/\?grant=[^#]+#join=/);
  // A machine in no group starts one of its own for the device.
  await waitFor(() => store.group !== null);
  expect(store.group!.cores.map(core => core.coreId)).toEqual([store.group!.self]);
  expect(document.querySelector('[data-testid=lan-reach]')).toBeNull();
});

test('the Tailscale switch serves the core over HTTPS, the Add a device link follows it, and off undoes both', async ({ app: _app }) => {
  store.showSettings('advanced', 'phone');
  await waitFor(() => document.querySelector('[data-testid=tailscale-access][data-state=off]') !== null);
  expect(query('[data-testid=tailscale-state]').textContent).toContain('https://boite-pc.tail0d6070.ts.net');
  query<HTMLButtonElement>('[data-testid=tailscale-enable]').click();
  // Turning it on mints the phone's link through the new address, and the window goes to the group card that shows it.
  await waitFor(() => store.deviceInvite?.url.startsWith('https://boite-pc.tail0d6070.ts.net/?grant=') === true);
  expect(store.settings?.publicUrl).toBe('https://boite-pc.tail0d6070.ts.net');
  await waitFor(() => store.settingsTab === 'machines' && document.querySelector('[data-testid=add-device-qr] svg') !== null);
  expect(store.settingsSection?.id).toBe('group');
  expect(document.querySelector('[data-testid=lan-reach]')).toBeNull();

  store.showSettings('advanced', 'phone');
  await waitFor(() => document.querySelector('[data-testid=tailscale-access][data-state=on]') !== null);
  query<HTMLButtonElement>('[data-testid=tailscale-disable]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => document.querySelector('[data-testid=tailscale-access][data-state=off]') !== null);
  expect(store.settings?.publicUrl ?? null).toBeNull();
});
