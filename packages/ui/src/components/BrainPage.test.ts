import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BrainPage from './BrainPage.svelte';
import type { Store } from '../lib/store.svelte';

let mounted: Record<string, unknown> | null = null;
afterEach(() => {
  if (mounted) unmount(mounted, { outro: false });
  mounted = null;
  document.body.innerHTML = '';
});

test('a refused sharing change keeps the saved switch state and shows the error', async () => {
  const call = vi.fn(async (method: string) => {
    if (method === 'brain.configure') throw new Error('Could not save brain settings');
    return { config: { path: '/work/brain', enabled: true }, entries: [], problems: [], git: null, lastSync: null };
  });
  const store = { client: { call }, owner: true, connection: 'ready' } as unknown as Store;
  mounted = mount(BrainPage, { target: document.body, props: { store } });
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector('[data-testid="brain-enabled"]')).not.toBeNull();
  });
  const control = document.querySelector<HTMLInputElement>('[data-testid="brain-enabled"]')!;
  control.click();
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save brain settings');
  });
  expect(control.checked).toBe(true);
  expect(call).toHaveBeenCalledWith('brain.configure', { path: '/work/brain', enabled: false });
});

test('automatic pull controls save their policy and preserve it when sharing changes', async () => {
  let config = { path: '/work/brain', enabled: true, autoPull: { onStartup: false, intervalMinutes: 0 } };
  const call = vi.fn(async (method: string, params?: typeof config) => {
    if (method === 'brain.configure') config = params!;
    return { config, entries: [], problems: [], git: { upstream: 'origin/main' }, lastSync: null };
  });
  mounted = mount(BrainPage, { target: document.body, props: { store: { client: { call }, owner: true, connection: 'ready' } as unknown as Store } });
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
