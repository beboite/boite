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
