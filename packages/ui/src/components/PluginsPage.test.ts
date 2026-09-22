import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PluginsPage from './PluginsPage.svelte';
import type { Store } from '../lib/store.svelte';
import { FakeClient } from '../lib/fake-client';

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

async function open(): Promise<void> {
  client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const store = { client, providers: [] } as unknown as Store;
  mounted = mount(PluginsPage, { target: document.body, props: { store } });
  await vi.waitFor(() => expect(row('kebacc-switcher')).not.toBeNull());
}

function type(selector: string, value: string): void {
  const input = q(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

test('browser plugin saves host settings and cancels a visible task', async () => {
  await open();
  await client!.call('plugins.install', { id: 'jev-browser' });
  await vi.waitFor(() => expect(q('[data-testid="browser-enabled"]')).not.toBeNull(), { timeout: 3000 });
  (q('[data-testid="browser-enabled"]') as HTMLInputElement).click();
  type('[data-testid="browser-executable"]', '  ');
  q('[data-testid="browser-save"]')!.click();
  await vi.waitFor(async () => expect((await client!.call('browser.status', {})).config).toEqual({ enabled: true, executablePath: null }));
  const task = await client!.call('browser.start', { threadId: 't1', pluginId: 'jev-browser', url: 'https://example.org', goal: 'Save weekly notifications', completion: { text: 'Saved' } });
  await vi.waitFor(() => expect(q('[data-testid="browser-task"]')?.textContent).toContain(task.goal));
  q('[data-testid="browser-cancel"]')!.click();
  await vi.waitFor(() => expect(q('[data-testid="browser-task"]')?.getAttribute('data-status')).toBe('cancelled'));
  expect(q('[data-testid="browser-cancel"]')).toBeNull();
});

test('each section holds its plugins, every state drawn with what the owner can do next', async () => {
  await open();
  const installed = q('[data-testid="plugins-installed"]')!;
  const recommended = q('[data-testid="plugins-recommended"]')!;
  expect([...installed.querySelectorAll('[data-testid="plugin-row"]')].map((el) => el.getAttribute('data-plugin'))).toEqual(['grok-seats', 'pool-legacy', 'seat-pool']);
  expect([...recommended.querySelectorAll('[data-testid="plugin-row"]')].map((el) => el.getAttribute('data-plugin'))).toEqual(['kebacc-switcher', 'jev-browser']);

  expect(row('kebacc-switcher')?.querySelector('[data-testid="plugin-install"]')).not.toBeNull();
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

test('uninstalling a URL plugin takes its row away; the recommended one goes back to Recommended', async () => {
  await open();
  const { confirm } = await import('../lib/confirm.svelte');
  const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
  try {
    (row('seat-pool')!.querySelector('[data-testid="plugin-uninstall"]') as HTMLElement).click();
    await vi.waitFor(() => expect(row('seat-pool')).toBeNull());
    (row('grok-seats')!.querySelector('[data-testid="plugin-cancel"]') as HTMLElement).click();
    await vi.waitFor(() => expect(row('grok-seats')).toBeNull());

    (row('kebacc-switcher')!.querySelector('[data-testid="plugin-install"]') as HTMLElement).click();
    await vi.waitFor(() => expect(q('[data-testid="plugins-installed"]')?.contains(row('kebacc-switcher'))).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(row('kebacc-switcher')?.querySelectorAll('[data-testid="plugin-pool"]').length).toBe(3));
    (row('kebacc-switcher')!.querySelector('[data-testid="plugin-uninstall"]') as HTMLElement).click();
    await vi.waitFor(() => expect(q('[data-testid="plugins-recommended"]')?.contains(row('kebacc-switcher'))).toBe(true));
    expect(ask).toHaveBeenCalledTimes(2);
  } finally {
    ask.mockRestore();
  }
});
