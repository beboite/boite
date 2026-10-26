import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { PluginState } from '@boite/contracts';
import PluginsPage from './PluginsPage.svelte';
import type { Store } from '../lib/store.svelte';
import { FakeClient } from '../lib/fake-client';
import { workspace } from '../lib/workspace.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let client: FakeClient | undefined;
afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = undefined;
  client?.close();
  document.body.innerHTML = '';
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const row = (id: string) => q(`[data-testid="plugin-row"][data-plugin="${id}"]`);

async function open(edit?: (rows: PluginState[]) => void): Promise<void> {
  client = new FakeClient({ delayMs: 0 });
  await client.connect();
  if (edit) {
    const call = client.call.bind(client);
    vi.spyOn(client, 'call').mockImplementation((async (method: string, params: unknown) => {
      const result = await call(method as never, params as never);
      if (method === 'plugins.list') edit(result as PluginState[]);
      return result;
    }) as never);
  }
  const store = { client, providers: [] } as unknown as Store;
  mounted = mount(PluginsPage, { target: document.body, props: { store } });
  await vi.waitFor(() => expect(row('bots')).not.toBeNull());
}

function type(selector: string, value: string): void {
  const input = q(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

test('each section holds its plugins, every state drawn with what the owner can do next', async () => {
  await open();
  const installed = q('[data-testid="plugins-installed"]')!;
  expect([...installed.querySelectorAll('[data-testid="plugin-row"]')].map((el) => el.getAttribute('data-plugin'))).toEqual(['bots', 'douane', 'grok-seats', 'pool-legacy', 'seat-pool']);
  // Every recommended plugin is installed: the section has nothing to say and is not drawn.
  expect(q('[data-testid="plugins-recommended"]')).toBeNull();
  // A recommended plugin links its source from its name; a URL one shows the repository and commit instead.
  expect(row('bots')?.querySelector('[data-testid="plugin-home"]')?.getAttribute('href')).toBe('https://github.com/Skollheim/bots');
  expect(row('seat-pool')?.querySelector('[data-testid="plugin-home"]')).toBeNull();
  expect(row('grok-seats')?.querySelector('[data-testid="plugin-progress"]')?.getAttribute('aria-valuenow')).toBe('45');
  expect(row('grok-seats')?.querySelector('[data-testid="plugin-cancel"]')).not.toBeNull();
  expect(row('seat-pool')?.textContent).toContain('github.com/example/seat-pool');
  expect(row('seat-pool')?.textContent).toContain('v1.4.0 at 3f9c2a7');
  await vi.waitFor(() => expect(row('seat-pool')?.querySelector('[data-testid="plugin-pool"][data-provider="opencode"]')).not.toBeNull());

  // The refused one says which file, which field, and what was expected; it can only go.
  const refused = row('pool-legacy')?.querySelector('[data-testid="plugin-rejected"]');
  expect(refused?.getAttribute('data-field')).toBe('manifest.schema');
  expect(refused?.textContent).toContain('installed.json');
  expect(row('pool-legacy')?.querySelector('[data-testid="plugin-retry"]')).toBeNull();
  expect(row('pool-legacy')?.querySelector('[data-testid="plugin-uninstall"]')).not.toBeNull();
  // Only a desktop app has the app strip.
  expect(row('seat-pool')?.querySelector('[data-testid="plugin-app"]')).toBeNull();
});

const app = (id: string) => row(id)?.querySelector<HTMLElement>('[data-testid="plugin-app"]') ?? null;
const appButton = (id: string, name: 'start' | 'stop' | 'restart') => app(id)?.querySelector<HTMLButtonElement>(`[data-testid="plugin-app-${name}"]`) ?? null;

test('a running desktop app can be stopped, then started again, its state following each step', async () => {
  await open();
  expect(app('bots')?.getAttribute('data-app-status')).toBe('running');
  expect(app('bots')?.textContent).toContain('Desktop app');
  expect(app('bots')?.textContent).toContain('Running');
  expect(appButton('bots', 'start')).toBeNull();
  expect(appButton('bots', 'restart')).not.toBeNull();

  appButton('bots', 'stop')!.click();
  await vi.waitFor(() => expect(app('bots')?.getAttribute('data-app-status')).toBe('stopped'));
  // It still starts with Boite, so the line says no more than stopped.
  expect(app('bots')?.textContent).not.toContain('starts again only when you start it');
  expect(appButton('bots', 'stop')).toBeNull();

  appButton('bots', 'start')!.click();
  await vi.waitFor(() => expect(app('bots')?.getAttribute('data-app-status')).toBe('running'));
  appButton('bots', 'restart')!.click();
  await vi.waitFor(() => expect(appButton('bots', 'restart')?.disabled).toBe(false));
  expect(app('bots')?.getAttribute('data-app-status')).toBe('running');
});

const autostart = (id: string) => row(id)?.querySelector<HTMLInputElement>('[data-testid="plugin-autostart"]') ?? null;

test('Start with Boite switches the app and the gateway apart from what runs now, and an older core shows no switch', async () => {
  await open();
  expect(autostart('bots')?.checked).toBe(true);
  expect(autostart('bots')?.closest('label')?.textContent).toContain('Start with Boite');
  autostart('bots')!.click();
  await vi.waitFor(() => expect(autostart('bots')?.checked).toBe(false));
  // The row stays where it was under the pointer.
  expect([...document.querySelectorAll('[data-testid="plugins-installed"] [data-testid="plugin-row"]')].map((el) => el.getAttribute('data-plugin')).slice(0, 2)).toEqual(['bots', 'douane']);
  // What runs now is left alone.
  expect(app('bots')?.getAttribute('data-app-status')).toBe('running');
  appButton('bots', 'stop')!.click();
  await vi.waitFor(() => expect(app('bots')?.textContent).toContain('Stopped · starts again only when you start it'));

  // Douane has the same switch on its gateway.
  expect(autostart('douane')?.checked).toBe(true);
  autostart('douane')!.click();
  await vi.waitFor(() => expect(autostart('douane')?.checked).toBe(false));
  expect(row('douane')?.querySelector('[data-testid="plugin-gateway"]')?.getAttribute('data-gateway-status')).toBe('running');

  unmount(mounted!); mounted = undefined; client?.close(); document.body.innerHTML = '';
  await open((rows) => { for (const plugin of rows) { if (plugin.app) delete plugin.app.autostart; if (plugin.gateway) delete plugin.gateway.autostart; } });
  expect(autostart('bots')).toBeNull();
  expect(autostart('douane')).toBeNull();
});

test('a crashed desktop app shows its exit code and why, and one with no desktop cannot start', async () => {
  const reason = 'This core has no desktop to show a window on: neither DISPLAY nor WAYLAND_DISPLAY is set.';
  await open((rows) => {
    const bots = rows.find((plugin) => plugin.id === 'bots')!;
    bots.app = { enabled: true, status: 'crashed', pid: null, exitCode: 3, error: 'bots exited with code 3 4 times in 5 minutes; start it again from Settings > Plugins.', startedAt: null };
    rows.push({ ...structuredClone(bots), id: 'headless', name: 'Headless', app: { enabled: true, status: 'unavailable', pid: null, exitCode: null, error: reason, startedAt: null } });
  });
  await vi.waitFor(() => expect(app('headless')).not.toBeNull());
  expect(app('bots')?.textContent).toContain('Crashed with exit code 3');
  expect(app('bots')?.querySelector('[data-testid="plugin-app-error"]')?.textContent).toContain('4 times in 5 minutes');
  expect(appButton('bots', 'start')?.disabled).toBe(false);

  expect(app('headless')?.textContent).toContain('Unavailable');
  expect(app('headless')?.querySelector('[data-testid="plugin-app-error"]')?.textContent).toBe(reason);
  expect(appButton('headless', 'start')?.disabled).toBe(true);
});

test('a desktop app\'s preview says it opens its own window and holds the owner token', async () => {
  await open();
  type('[data-testid="plugin-url"]', 'https://github.com/example/desktop-pets');
  q('[data-testid="plugin-inspect"]')!.click();
  await vi.waitFor(() => expect(q('[data-testid="plugin-preview"]')).not.toBeNull());
  const preview = q('[data-testid="plugin-preview"]')!;
  expect(q('[data-testid="plugin-preview-app"]')?.textContent).toContain('Opens a window of its own and gets full access to Boite through the owner token');
  expect(preview.textContent).toContain('BOITE_TOKEN=<the owner token>');
  expect(preview.textContent).not.toContain('Account pools');

  q('[data-testid="plugin-add"]')!.click();
  await vi.waitFor(() => expect(app('desktop-pets')?.getAttribute('data-app-status')).toBe('running'), { timeout: 3000 });
});

test('a URL is read first, shown with what it downloads and runs, and installs only on confirm', async () => {
  await open();
  type('[data-testid="plugin-url"]', 'https://github.com/example/pi-pool');
  type('[data-testid="plugin-ref"]', 'v1.5.0');
  q('[data-testid="plugin-inspect"]')!.click();
  await vi.waitFor(() => expect(q('[data-testid="plugin-preview"]')).not.toBeNull());
  const preview = q('[data-testid="plugin-preview"]')!;
  expect(preview.getAttribute('data-rejected')).toBe('false');
  expect(q('[data-testid="plugin-artifact"]')?.textContent).toBe('https://github.com/example/pi-pool/releases/download/v1.5.0/pi-pool-win32-x64.exe');
  expect(preview.textContent).toContain('v1.5.0 at e7d1c9a');
  expect(preview.textContent).toContain('pi-pool switch -<pool> -Email <email> -Yes');
  // Nothing is installed until the owner says so.
  expect(row('pi-pool')).toBeNull();

  q('[data-testid="plugin-add"]')!.click();
  await vi.waitFor(() => expect(row('pi-pool')?.getAttribute('data-status')).toBe('installing'));
  expect(q('[data-testid="plugin-preview"]')).toBeNull();
  expect((q('[data-testid="plugin-url"]') as HTMLInputElement).value).toBe('');
  expect(q('[data-testid="plugins-installed"]')?.contains(row('pi-pool'))).toBe(true);
  await vi.waitFor(() => expect(row('pi-pool')?.getAttribute('data-status')).toBe('installed'), { timeout: 3000 });
});

test('a refused manifest shows the file, the field and what was expected, with no way to install it', async () => {
  await open();
  type('[data-testid="plugin-url"]', 'https://github.com/example/broken-pool');
  q('[data-testid="plugin-inspect"]')!.click();
  await vi.waitFor(() => expect(q('[data-testid="plugin-preview"]')).not.toBeNull());
  expect(q('[data-testid="plugin-preview"]')?.getAttribute('data-rejected')).toBe('true');
  const refused = q('[data-testid="plugin-preview"] [data-testid="plugin-rejected"]');
  expect(refused?.getAttribute('data-field')).toBe('artifacts.win32-x64.sha256');
  expect(refused?.textContent).toContain('boite-plugin.json');
  expect(refused?.textContent).toContain('64 lowercase hexadecimal characters');
  expect(q('[data-testid="plugin-add"]')).toBeNull();

  // Anything but https is refused before the core fetches.
  type('[data-testid="plugin-url"]', 'http://github.com/example/pi-pool');
  q('[data-testid="plugin-inspect"]')!.click();
  await vi.waitFor(() => expect(q('[data-testid="plugin-inspect-error"]')?.textContent).toContain('plugin url must be an https URL'));
  expect(q('[data-testid="plugin-preview"]')).toBeNull();
});

test('uninstalling a URL plugin takes its row away; the recommended one goes back to Recommended and installs again', async () => {
  await open();
  const { confirm } = await import('../lib/confirm.svelte');
  const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
  try {
    (row('seat-pool')!.querySelector('[data-testid="plugin-uninstall"]') as HTMLElement).click();
    await vi.waitFor(() => expect(row('seat-pool')).toBeNull());
    (row('grok-seats')!.querySelector('[data-testid="plugin-cancel"]') as HTMLElement).click();
    await vi.waitFor(() => expect(row('grok-seats')).toBeNull());

    (row('bots')!.querySelector('[data-testid="plugin-uninstall"]') as HTMLElement).click();
    await vi.waitFor(() => expect(q('[data-testid="plugins-recommended"]')?.contains(row('bots'))).toBe(true));
    // Not installed: keep Install and the source check, without an installed state line.
    expect(row('bots')?.querySelector('.state')).toBeNull();
    expect(row('bots')?.querySelector('[data-testid="plugin-updates"]')).not.toBeNull();
    expect(row('bots')?.querySelector('[data-testid="plugin-check-updates"]')).not.toBeNull();

    (row('bots')!.querySelector('[data-testid="plugin-install"]') as HTMLElement).click();
    await vi.waitFor(() => expect(q('[data-testid="plugins-installed"]')?.contains(row('bots'))).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(app('bots')?.getAttribute('data-app-status')).toBe('running'));
    expect(q('[data-testid="plugins-recommended"]')).toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);
  } finally {
    ask.mockRestore();
  }
});

test('a recommended plugin with an update source says what it last found, and a check offers the newer release', async () => {
  await open((rows) => {
    const bots = rows.find((plugin) => plugin.id === 'bots')!;
    bots.updates = { ...bots.updates!, checkedAt: Date.now() - 3 * 3_600_000 };
  });
  const bots = () => row('bots')!;
  const line = () => bots().querySelector('[data-testid="plugin-updates-line"]')?.textContent ?? '';
  expect(line()).toBe('Up to date · checked 3 hr. ago');
  expect(bots().querySelector('[data-testid="plugin-update"]')).toBeNull();

  (bots().querySelector('[data-testid="plugin-check-updates"]') as HTMLElement).click();
  await vi.waitFor(() => expect(bots().querySelector('[data-testid="plugin-update"]')?.textContent).toBe('Update to v0.1.10'));
  expect(line()).toBe('Found at github.com/Skollheim/bots, main at 6b2e4d8 · checked now');
  expect(bots().textContent).toContain('Installed · v0.1.10 available');

  (bots().querySelector('[data-testid="plugin-update"]') as HTMLElement).click();
  await vi.waitFor(() => expect(bots().getAttribute('data-status')).toBe('installed'), { timeout: 3000 });
  await vi.waitFor(() => expect(bots().querySelector('h3')?.textContent).toContain('v0.1.10'), { timeout: 3000 });
  expect(bots().querySelector('[data-testid="plugin-update"]')).toBeNull();
});

test('opening recommendations checks their sources without installing or blocking the list', async () => {
  client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const call = client.call.bind(client);
  let finish!: (rows: PluginState[]) => void;
  const latest = new Promise<PluginState[]>((resolve) => { finish = resolve; });
  let recommendation!: PluginState;
  const calls = vi.spyOn(client, 'call').mockImplementation((async (method: string, params: unknown) => {
    if (method === 'plugins.checkUpdates') return latest;
    const result = await call(method as never, params as never);
    if (method === 'plugins.list') {
      recommendation = (result as PluginState[]).find((plugin) => plugin.id === 'bots')!;
      Object.assign(recommendation, { version: null, status: 'not-installed', app: null });
    }
    return result;
  }) as never);
  const store = { client, providers: [] } as unknown as Store;
  mounted = mount(PluginsPage, { target: document.body, props: { store } });

  await vi.waitFor(() => expect(q('[data-testid="plugins-recommended"]')?.contains(row('bots'))).toBe(true));
  expect(row('bots')?.querySelector('[data-testid="plugin-install"]')).not.toBeNull();
  await vi.waitFor(() => expect(calls).toHaveBeenCalledWith('plugins.checkUpdates', { id: 'bots' }));
  expect(calls.mock.calls.filter(([method]) => method === 'plugins.checkUpdates')).toHaveLength(1);
  expect(row('bots')?.querySelector('[data-testid="plugin-check-updates"]')).not.toBeNull();

  finish([{ ...recommendation, availableVersion: '0.1.21', updates: {
    ...recommendation.updates!, checkedAt: Date.now(), available: { version: '0.1.21', commit: 'c'.repeat(40), checkedAt: Date.now() },
  } }]);
  await vi.waitFor(() => expect(row('bots')?.querySelector('h3')?.textContent).toContain('v0.1.21'));
  expect(row('bots')?.querySelector('[data-testid="plugin-updates-line"]')?.textContent).toContain('Found at github.com/Skollheim/bots');
  expect(calls.mock.calls.some(([method]) => method === 'plugins.install')).toBe(false);
  expect(q('[data-testid="plugins-recommended"]')?.contains(row('bots'))).toBe(true);
});

test('an ignored release and a failed check read as quiet notes, never alarms', async () => {
  await open((rows) => {
    const bots = rows.find((plugin) => plugin.id === 'bots')!;
    bots.updates = { ...bots.updates!, ignored: '0.1.8 found there, older than 0.1.9; Boite never goes back.' };
  });
  const updates = row('bots')!.querySelector('[data-testid="plugin-updates"]')!;
  expect(updates.textContent).toContain('Not offered: 0.1.8 found there, older than 0.1.9; Boite never goes back.');
  expect(updates.querySelector('[role="alert"], .bad')).toBeNull();
});
test('Douane\'s row shows its gateway on loopback, stops and starts it, and its uninstall says the sign-ins stay', async () => {
  await open();
  const strip = () => q('[data-testid="plugin-gateway"][data-plugin="douane"]');
  await vi.waitFor(() => expect(strip()?.dataset.gatewayStatus).toBe('running'));
  expect(q('[data-testid="plugin-gateway-state"]')?.textContent).toContain('0.3.0 on 127.0.0.1:8787');
  // The page runs at a loopback address, beside its core: the dashboard opens from here.
  expect(q('[data-testid="plugin-gateway-open"]')?.textContent).toContain('Open Douane');

  q('[data-testid="plugin-gateway-stop"]')!.click();
  await vi.waitFor(() => expect(strip()?.dataset.gatewayStatus).toBe('stopped'));
  // It starts with Boite, so a stop holds only until then and the line says stopped.
  expect(q('[data-testid="plugin-gateway-state"]')?.textContent).toContain('Stopped');
  expect(q('[data-testid="plugin-gateway-state"]')?.textContent).not.toContain('starts again only when you start it');
  q('[data-testid="plugin-gateway-start"]')!.click();
  await vi.waitFor(() => expect(strip()?.dataset.gatewayStatus).toBe('running'));

  const { confirm } = await import('../lib/confirm.svelte');
  const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
  q('[data-testid="plugin-uninstall"][data-plugin="douane"]')!.click();
  await vi.waitFor(() => expect(ask).toHaveBeenCalled());
  expect(ask.mock.calls[0]![0].body).toMatch(/sign-ins, settings and database stay in .*douane/);
  expect(strip()).not.toBeNull();
  ask.mockRestore();
});
