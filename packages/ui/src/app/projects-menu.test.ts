import { expect, vi } from 'vitest';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import { query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('project menus keep Mark done separate from Archive, which can stop pending work', async ({ app: _app }) => {
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length === 4);

  const row = query<HTMLButtonElement>('[data-thread-id="t-bench"]');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  const labels = Array.from(document.querySelectorAll('[data-testid=context-menu] [data-row]')).map((el) => el.textContent?.trim());
  expect(labels).toEqual(['Open', 'Pin', 'Mark done', 'Archive', 'Rename', 'Regenerate title', 'Move to project', 'Copy path', 'Delete']);
  expect(query('[data-testid=context-menu] [data-value=copy]').getAttribute('title')).toBe('C:\\src\\boite');
  // t-bench waits on a permission: its turn still runs, and a move would wait for it to end.
  expect(query<HTMLButtonElement>('[data-testid=context-menu] [data-value=move]').disabled).toBe(false);
  expect(query<HTMLButtonElement>('[data-testid=context-menu] [data-value=done]').disabled).toBe(true);
  expect(query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archive]').disabled).toBe(false);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archive]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);
  await waitFor(() => document.querySelector('[data-thread-id="t-bench"]') === null);
  expect(store.pendingPermissions.some(p => p.threadId === 't-bench')).toBe(false);
  expect(document.querySelector('[data-testid=confirm-dialog]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=undo-action]').click();
  await waitFor(() => document.querySelector('[data-thread-id="t-bench"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-bench"]').click();
  await waitFor(() => store.openThread?.id === 't-bench');
  query('[data-testid=thread-title]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  expect(query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archive]').disabled).toBe(false);

  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archive]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);
  // Restoring stopped work also keeps the header's direct archive action.
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length === 3);
  expect(document.querySelector('[data-thread-id="t-bench"]')).toBeNull();
  expect(document.querySelector('[data-testid=confirm-dialog]')).toBeNull();
});

test('removing a project asks first, and Cancel keeps it', async ({ app: _app }) => {
  const head = query('[data-project-id="p-notes"][data-testid=project-row]');
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=remove]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=remove]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  expect(document.querySelector('[data-testid=confirm-dialog]')?.textContent).toContain('notes');

  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(store.projects.length).toBe(2);
});
