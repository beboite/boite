import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { type RpcMethodName } from '@boite/contracts';
import { store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import { projectMenu } from '../lib/project-menu';
import { query, showMobileThreads, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('browser Add project opens a path form and starts a draft in the added folder', async ({ app: _app }) => {
  const before = store.projects.length;
  store.sidebarOpen = true;
  query<HTMLButtonElement>('[data-testid=add-project]').click();
  // The form is loaded on demand: the first test of a file pays that import.
  await waitFor(() => document.querySelector('[data-testid=add-project-form]') !== null);
  expect(store.page).toBe('chat');
  await type(query<HTMLInputElement>('[data-testid=project-path]'), 'D:\\work\\another-project');
  query<HTMLButtonElement>('[data-testid=project-add]').click();
  await waitFor(() => store.projects.length === before + 1);
  const added = store.projects.find((p) => p.path === 'D:\\work\\another-project')!;
  expect(store.draft?.projectId).toBe(added.id);
  expect(store.sidebarOpen).toBe(false);
  await waitFor(() => document.querySelector('[data-testid=add-project-form]') === null);
});

test('browser Add project keeps refused paths and Escape returns to its button', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=add-project]').focus();
  query<HTMLButtonElement>('[data-testid=add-project]').click();
  await waitFor(() => document.querySelector('[data-testid=project-path]') !== null);
  const field = query<HTMLInputElement>('[data-testid=project-path]');
  await waitFor(() => document.activeElement === field);
  const client = store.client!;
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'projects.add') return Promise.reject(new Error('folder not found'));
    return call<RpcMethodName>(method, params);
  });
  try {
    await type(field, 'D:\\missing-project');
    query<HTMLButtonElement>('[data-testid=project-add]').click();
    await waitFor(() => store.error === 'folder not found');
    expect(field.value).toBe('D:\\missing-project');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('[data-testid=add-project-form]') === null);
    expect(document.activeElement).toBe(query('[data-testid=add-project]'));
    expect(store.page).toBe('chat');
  } finally {
    spy.mockRestore();
  }
});

test('the phone list header holds the project picker, the bottom bar the new thread, and neither manages a project', async ({ app: _app }) => {
  store.startDraft('p-boite');
  await showMobileThreads();
  await waitFor(() => query('[data-testid=mobile-project]').getAttribute('aria-label')?.includes('boite') === true);
  expect(document.querySelector('[data-testid=mobile-tabs] [data-testid=mobile-new]')).not.toBeNull();
  expect(document.querySelector('[data-testid=mobile-project-actions]')).toBeNull();
  // Adding a project is the picker's last row.
  query<HTMLButtonElement>('[data-testid=mobile-project]').click();
  await waitFor(() => document.querySelector('[data-value=add-project]') !== null);
  query<HTMLButtonElement>('[data-value=add-project]').click();
  await waitFor(() => store.projectPickerOpen);
});

test('a project menu cannot archive an already archived project or offer a misleading undo', async ({ app: _app }) => {
  const row = query('[data-testid=project-row]');
  const project = store.projects.find(p => p.id === row.getAttribute('data-project-id'))!;
  const archive = vi.spyOn(store, 'archiveProject');
  // The menu opens on the row; once archived the row leaves the list, and the menu is asked for the archived project itself.
  const openManagement = async () => {
    const current = store.projects.find(p => p.id === project.id)!;
    if (current.archived) projectMenu(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), store, current);
    else query(`[data-testid=project-row][data-project-id="${project.id}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('[data-value=manage]') !== null);
    query<HTMLButtonElement>('[data-value=manage]').click();
    await waitFor(() => document.querySelector('[data-value=archive-project]') !== null);
  };
  try {
    await openManagement();
    // Another client can archive the project while this menu stays open.
    store.projects = store.projects.map(p => p.id === project.id ? { ...p, archived: true } : p);
    flushSync();
    query<HTMLButtonElement>('[data-value=archive-project]').click();
    await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);
    expect(archive).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid=undo-toast]')).toBeNull();
    await openManagement();
    expect(query<HTMLButtonElement>('[data-value=archive-project]').disabled).toBe(true);
  } finally {
    archive.mockRestore();
  }
});
