import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('a permission left pending is read back on connect and answered from its card', async ({ app: _app }) => {
  // Nothing streamed here: the request comes from permissions.list, not the event.
  await waitFor(() => store.pendingPermissions.some((p) => p.threadId === 't-bench'));
  await waitFor(() => document.querySelector('[data-thread-id="t-bench"]') !== null);

  query<HTMLButtonElement>('[data-thread-id="t-bench"]').click();
  await waitFor(() => store.openThread?.id === 't-bench');
  await waitFor(() => document.querySelector('[data-testid=permission-card]') !== null);
  expect(query('[data-testid=permission-card]').getAttribute('data-decision')).toBe('pending');
  expect(query('[data-testid=permission-input]').textContent).toContain('run.ts');

  query<HTMLButtonElement>('[data-testid=permission-allow]').click();
  await waitFor(() => query('[data-testid=permission-card]').getAttribute('data-decision') === 'allow');
  expect(store.pendingPermissions.some((p) => p.threadId === 't-bench')).toBe(false);
  expect(query('[data-testid=permission-verdict]').textContent?.trim()).toBe('Allowed');
});
