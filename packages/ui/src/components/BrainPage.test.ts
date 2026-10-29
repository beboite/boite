import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BrainPage from './BrainPage.svelte';
import type { Store } from '../lib/store.svelte';

let mounted: Record<string, unknown> | null = null;

/** The Hooks card under the brain asks for its own status and listens for runs; these tests are about the brain. */
function client(call: (method: string, params?: never) => Promise<unknown>) {
  return { call: async (method: string, params?: never) => method === 'hooks.status' ? { since: 0, providers: [], recent: [] } : call(method, params), on: () => () => {} };
}
afterEach(() => {
  if (mounted) unmount(mounted, { outro: false });
  mounted = null;
  document.body.innerHTML = '';
});

test('Windows link failures explain Developer Mode and retry the saved configuration', async () => {
  const config = { path: 'C:/brain', enabled: true, globalInstructions: true, boiteGuide: false };
  const call = vi.fn(async (method: string) => ({ config, entries: [], problems: [], git: null, lastSync: null,
    links: [{ name: 'Codex', path: 'C:/Users/user/.codex/AGENTS.md', state: method === 'brain.configure' ? 'linked' : 'blocked',
      error: method === 'brain.configure' ? null : 'EPERM: symlink', ...(method === 'brain.configure' ? {} : { remedy: 'windows-developer-mode' }) }] }));
  const store = { client: client(call), owner: true, connection: 'ready', keep: vi.fn() } as unknown as Store;
  mounted = mount(BrainPage, { target: document.body, props: { store } });
  await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-testid="brain-link-help"]')?.textContent).toContain('Developer Mode'); });
  expect(document.querySelector('[data-testid="brain-link-help"]')?.textContent).toContain('ms-settings:developers');
  expect(document.querySelector('[data-testid="brain-link-help"]')?.textContent).toContain('Win+R');
  document.querySelector<HTMLButtonElement>('[data-testid="brain-link-retry"]')!.click();
  await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-testid="brain-link-help"]')).toBeNull(); });
  expect(call).toHaveBeenCalledWith('brain.configure', config);
  expect(document.querySelector<HTMLInputElement>('[data-testid="brain-global"]')!.checked).toBe(true);
});

test('restoration problems remain visible after disconnecting the folder', async () => {
  const call = vi.fn(async (method: string) => ({ config: { path: null, enabled: false }, entries: [], problems: [], git: null, lastSync: null,
    links: method === 'brain.configure' ? [] : [{ name: 'Codex', path: '/home/user/.codex/AGENTS.md', state: 'blocked', error: 'Restore pending; original backup preserved' }] }));
  mounted = mount(BrainPage, { target: document.body, props: { store: { client: client(call), owner: true, connection: 'ready' } as unknown as Store } });
  await vi.waitFor(() => { flushSync(); expect([...document.querySelectorAll('[role="alert"]')].some(alert => alert.textContent?.includes('original backup preserved'))).toBe(true); });
  expect(document.querySelector('[data-testid="brain-link-help"]')?.textContent).not.toContain('Developer Mode');
  document.querySelector<HTMLButtonElement>('[data-testid="brain-link-retry"]')!.click();
  await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-testid="brain-link-help"]')).toBeNull(); });
  expect(call).toHaveBeenCalledWith('brain.configure', { path: null, enabled: false });
});

test.each(['enabled', 'global', 'guide'])('a refused %s change keeps the saved switch state and shows the error', async name => {
  const call = vi.fn(async (method: string) => {
    if (method === 'brain.configure') throw new Error('Could not save brain settings');
    return { config: { path: '/work/brain', enabled: true }, entries: [], problems: [], git: null, lastSync: null };
  });
  const store = { client: client(call), owner: true, connection: 'ready' } as unknown as Store;
  mounted = mount(BrainPage, { target: document.body, props: { store } });
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector('[data-testid="brain-enabled"]')).not.toBeNull();
  });
  const control = document.querySelector<HTMLInputElement>(`[data-testid="brain-${name}"]`)!;
  expect(control).not.toBeNull();
  control.click();
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save brain settings');
  });
  // The guide is on until turned off, so its saved state is checked too.
  expect(control.checked).toBe(name !== 'global');
  expect(call).toHaveBeenCalledWith('brain.configure', {
    enabled: { path: '/work/brain', enabled: false },
    global: { path: '/work/brain', enabled: true, globalInstructions: true },
    guide: { path: '/work/brain', enabled: true, boiteGuide: false },
  }[name]);
});

test('automatic pull controls save their policy and preserve it when sharing changes', async () => {
  let config = { path: '/work/brain', enabled: true, autoPull: { onStartup: false, intervalMinutes: 0 } };
  const call = vi.fn(async (method: string, params?: typeof config) => {
    if (method === 'brain.configure') config = params!;
    return { config, entries: [], problems: [], git: { upstream: 'origin/main' }, lastSync: null };
  });
  mounted = mount(BrainPage, { target: document.body, props: { store: { client: client(call), owner: true, connection: 'ready' } as unknown as Store } });
  const control = (name: string) => document.querySelector<HTMLInputElement>(`[data-testid="brain-${name}"]`)!;
  await vi.waitFor(() => { flushSync(); expect(control('startup')).not.toBeNull(); });
  config = { ...config, enabled: false };
  control('refresh').click();
  await vi.waitFor(() => { flushSync(); expect(control('enabled').checked).toBe(false); expect(control('startup').disabled).toBe(false); });
  control('startup').click();
  await vi.waitFor(() => { flushSync(); expect(config.autoPull.onStartup).toBe(true); expect(control('startup').disabled).toBe(false); });
  expect(config.enabled).toBe(false);
  control('periodic').click();
  await vi.waitFor(() => { flushSync(); expect(config.autoPull.intervalMinutes).toBe(15); expect(control('periodic').disabled).toBe(false); });
  control('interval').value = '30';
  control('interval').dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => { flushSync(); expect(config.autoPull.intervalMinutes).toBe(30); expect(control('enabled').disabled).toBe(false); });
  control('enabled').click();
  await vi.waitFor(() => { flushSync(); expect(config.enabled).toBe(true); });
  expect(config.autoPull).toEqual({ onStartup: true, intervalMinutes: 30 });
});

test('a change made elsewhere shows at once, and the next switch writes the configuration the core holds', async () => {
  let configured: ((config: unknown) => void) | undefined;
  const call = vi.fn(async (method: string, params?: unknown) => method === 'brain.configure'
    ? { config: params, entries: [], problems: [], git: null, lastSync: null }
    : { config: { path: '/work/brain', enabled: true, globalInstructions: false, boiteGuide: true }, entries: [], problems: [], git: null, lastSync: null });
  const store = {
    client: { ...client(call as never), on: (event: string, handler: (config: unknown) => void) => { if (event === 'brain.configured') configured = handler; return () => {}; } },
    owner: true, connection: 'ready', keep: vi.fn(async () => undefined)
  } as unknown as Store;
  mounted = mount(BrainPage, { target: document.body, props: { store } });
  await vi.waitFor(() => { flushSync(); expect(document.querySelector<HTMLInputElement>('[data-testid="brain-global"]')?.checked).toBe(false); });
  // The default machine's copy turned the instructions on.
  configured!({ path: '/work/brain', enabled: true, globalInstructions: true, boiteGuide: true });
  flushSync();
  expect(document.querySelector<HTMLInputElement>('[data-testid="brain-global"]')!.checked).toBe(true);
  document.querySelector<HTMLInputElement>('[data-testid="brain-guide"]')!.click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('brain.configure', expect.objectContaining({ globalInstructions: true, boiteGuide: false })));
});

test('another folder chosen elsewhere reads that folder again, not only its switches', async () => {
  let configured: ((config: unknown) => void) | undefined;
  const first = { config: { path: '/work/brain', enabled: true }, entries: [{ kind: 'instructions', name: 'OLD-AGENTS.md', path: 'OLD-AGENTS.md', description: '', error: null }], problems: [], git: null, lastSync: null };
  const second = { config: { path: '/other/brain', enabled: true }, entries: [], problems: [], git: null, lastSync: null };
  let current: unknown = first;
  const call = vi.fn(async () => current);
  const store = {
    client: { ...client(call as never), on: (event: string, handler: (config: unknown) => void) => { if (event === 'brain.configured') configured = handler; return () => {}; } },
    owner: true, connection: 'ready', keep: vi.fn(async () => undefined)
  } as unknown as Store;
  mounted = mount(BrainPage, { target: document.body, props: { store } });
  await vi.waitFor(() => { flushSync(); expect(document.body.textContent).toContain('OLD-AGENTS.md'); });
  current = second;
  configured!(second.config);
  await vi.waitFor(() => { flushSync(); expect(document.body.textContent).not.toContain('OLD-AGENTS.md'); });
});
