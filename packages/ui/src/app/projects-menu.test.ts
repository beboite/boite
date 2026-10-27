import { expect, vi } from 'vitest';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import { projectMenu } from '../lib/project-menu';
import { query, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('renaming a project selects its current name, rejects blanks, saves with Enter and cancels with Escape', async ({ app: _app }) => {
  const project = store.projects.find(p => p.id === 'p-boite')!;
  const path = project.path;
  async function rename() {
    query('[data-project-id="p-boite"][data-testid=project-row]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
    await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=rename]') !== null);
    query<HTMLButtonElement>('[data-testid=context-menu] [data-value=rename]').click();
    await waitFor(() => document.activeElement?.getAttribute('data-testid') === 'confirm-name');
    return query<HTMLInputElement>('[data-testid=confirm-name]');
  }
  const input = await rename();
  expect(input.value).toBe(project.name);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, project.name.length]);
  await type(input, '  ');
  expect(query<HTMLButtonElement>('[data-testid=confirm-ok]').disabled).toBe(true);
  await type(input, '  My project  ');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => store.projects.find(p => p.id === project.id)?.name === 'My project');
  expect(store.projects.find(p => p.id === project.id)?.path).toBe(path);
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(query('[data-project-id="p-boite"][data-testid=project-row]').textContent).toContain('My project');
  const again = await rename();
  await type(again, 'Discard this');
  again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(store.projects.find(p => p.id === project.id)?.name).toBe('My project');
});

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

test('a project rename belongs to its own machine and a prompt cannot follow a replaced client', async ({ app: _app, ready }) => {
  const remote = await ready({ delayMs: 0 });
  const project = remote.store.projects.find(p => p.id === 'p-boite')!;
  const localName = store.projects.find(p => p.id === project.id)!.name;
  async function prompt() {
    projectMenu(new MouseEvent('click', { clientX: 30, clientY: 50 }), remote.store, project);
    await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=rename]') !== null);
    query<HTMLButtonElement>('[data-testid=context-menu] [data-value=rename]').click();
    await waitFor(() => document.activeElement?.getAttribute('data-testid') === 'confirm-name');
  }
  await prompt();
  await type(query<HTMLInputElement>('[data-testid=confirm-name]'), 'Remote project');
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => remote.store.projects.find(p => p.id === project.id)?.name === 'Remote project');
  expect(store.projects.find(p => p.id === project.id)?.name).toBe(localName);
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  await prompt();
  remote.store.detach();
  remote.store.attach(remote.client);
  await remote.store.connect();
  const asked = vi.spyOn(remote.client, 'call');
  await type(query<HTMLInputElement>('[data-testid=confirm-name]'), 'Wrong client');
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => confirm.current === null);
  expect(asked.mock.calls.some(([method]) => method === 'projects.rename')).toBe(false);
  expect(remote.store.projects.find(p => p.id === project.id)?.name).toBe('Remote project');
});
