import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { setExperiment } from '../lib/experiments';
import { mountOnFake, press, query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the project menu carries no import until the session-import experiment is on', async () => {
  store.draft = null;
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-testid=project-row][data-project-id="p-boite"]') !== null);

  const head = query<HTMLElement>('[data-testid=project-row][data-project-id="p-boite"]');
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=copy]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=back]') !== null);
  expect(document.querySelector('[data-testid=context-menu] [data-value=import]')).toBeNull();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);

  // The switch on the Experiments page is what puts the row in, no reload.
  setExperiment('session-import', true);
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=import]') !== null);
});

test('Import a Claude Code session in the project menu lists the transcripts and opens the imported thread', async () => {
  store.draft = null;
  setExperiment('session-import', true);
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-testid=project-row][data-project-id="p-boite"]') !== null);

  const head = query<HTMLElement>('[data-testid=project-row][data-project-id="p-boite"]');
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=import]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=import]').click();

  // The dialog opens at once and says it is reading; the rows follow.
  await waitFor(() => document.querySelector('[data-testid=import-dialog]') !== null);
  expect(document.querySelector('[data-testid=import-loading]')).not.toBeNull();
  await waitFor(() => document.querySelectorAll('[data-testid=import-row]').length === 2);
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid=import-row]'));
  expect(rows.map((row) => row.querySelector('.title')?.textContent)).toEqual(['Finish the trace tab', 'Where the shell looks for a core']);
  // The session that is already the trace thread cannot be taken twice.
  expect(rows[0]?.disabled).toBe(true);
  expect(rows[0]?.querySelector('.hint')?.textContent).toBe('Imported');
  expect(rows[1]?.disabled).toBe(false);

  const before = store.threads.length;
  rows[1]?.click();
  await waitFor(() => document.querySelector('[data-testid=import-dialog]') === null);
  expect(store.threads.length).toBe(before + 1);
  const imported = store.threads.find((thread) => thread.title === 'Where the shell looks for a core');
  expect(imported).toMatchObject({ projectId: 'p-boite', titleSource: 'agent', sessionId: '4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' });
  await waitFor(() => query('[data-testid=thread-title]').textContent?.trim() === 'Where the shell looks for a core');
  expect(store.openThread?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

  // Escape closes the dialog when it is open again.
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=import]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=import]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=import-row]').length === 2);
  expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid=import-row]')).every((row) => row.disabled)).toBe(true);
  press('Escape');
  await waitFor(() => document.querySelector('[data-testid=import-dialog]') === null);
});
