import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import { projectThreadView } from '../lib/project-threads.svelte';
import { sidebarRows } from '../lib/sidebar-rows.svelte';
import { emptyCore, mountOnFake, query, test, type, unmountApp, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the app mounts against the fake core, lists the seeded threads and opens the latest', async ({ app: _app }) => {
  await waitFor(() => store.threads.length === 4);
  await waitFor(() => (document.body.textContent ?? '').includes('Finish the trace tab'));

  const text = document.body.textContent ?? '';
  expect(text).toContain('boite');
  expect(text).toContain('Port the scheduler');
  // One machine that is connected needs no word about it.
  expect(text).not.toContain('1 machine connected');
  expect(document.querySelector('[data-testid=composer-input]')).not.toBeNull();
  expect(document.querySelectorAll('[data-testid=thread-row]').length).toBe(4);
  // The most recent thread opens on its own; nothing to click first.
  expect(store.openThread?.id).toBe('t-descriptors');
});

test('Alt+digit reaches the history unfolded under an idle project, after the listed projects', async ({ app: _app }) => {
  try {
    // The digits follow the rows as drawn, sorted once for both.
    const drawn = () => [...document.querySelectorAll<HTMLElement>('[data-testid=thread-row]')].map(row => row.dataset.threadId);
    await waitFor(() => sidebarRows.list.length === drawn().length);
    expect(sidebarRows.list.map(entry => entry.threadId)).toEqual(drawn());
    await store.open('t-trace');
    await store.archive('t-descriptors', true);
    projectThreadView.shelfOpen = true;
    const row = '[data-testid=idle-project][data-project-id="p-notes"]';
    await waitFor(() => document.querySelector(`${row} [data-testid$=-toggle]`) !== null);
    query<HTMLButtonElement>(`${row} [data-testid$=-toggle]`).click();
    await waitFor(() => document.querySelector(`${row} [data-testid=done-thread]`) !== null);
    await waitFor(() => sidebarRows.list.at(-1)?.threadId === 't-descriptors');
    expect(sidebarRows.list.map(entry => entry.threadId)).toEqual([...store.threadsOf('p-boite').map(() => expect.any(String)), 't-descriptors']);
  } finally {
    projectThreadView.shelfOpen = false;
    projectThreadView.done = [];
    projectThreadView.archived = [];
  }
});

test('the page leaves the service worker its notification words on boot', async () => {
  const put = vi.fn(async (_path: string, _response: Response) => {});
  // Set and removed by hand: unstubAllGlobals would also drop test-setup's ResizeObserver and matchMedia.
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: vi.fn(async () => ({ put })) } });
  try {
    await mountOnFake();
    await waitFor(() => put.mock.calls.length > 0);
    const [path, response] = put.mock.calls[0]!;
    expect(path).toBe('/notification-words');
    expect(await response.json()).toMatchObject({ done: expect.any(String), needsYou: expect.any(String) });
  } finally { Reflect.deleteProperty(globalThis, 'caches'); }
});

test('the app opens on a new thread in the project last worked in', async () => {
  await mountOnFake('/?fake=1&open=landing');
  await waitFor(() => store.draft !== null);
  expect(store.openThread).toBeNull();
  // Nothing remembered on this device yet: the project of the most recent thread.
  expect(store.draft?.projectId).toBe('p-notes');
  expect(document.querySelector('[data-testid=composer-input]')).not.toBeNull();

  store.startDraft('p-boite');
  unmountApp();
  await mountOnFake('/?fake=1&open=landing');
  await waitFor(() => store.draft !== null);
  expect(store.draft?.projectId).toBe('p-boite');

  // Settings opened before the core answered is not taken back by the landing.
  store.draft = null;
  store.showSettings();
  await store.openLanding();
  expect(store.draft).toBeNull();
  expect(store.page).toBe('settings');
});

test('a project folded in the sidebar is still folded after a restart', async () => {
  await mountOnFake();
  const head = (id: string) => query<HTMLButtonElement>(`[data-testid=project-row][data-project-id="${id}"]`);
  await waitFor(() => document.querySelector('[data-testid=project-row][data-project-id="p-boite"]') !== null);
  head('p-boite').click();
  await waitFor(() => head('p-boite').getAttribute('aria-expanded') === 'false');

  unmountApp();
  // A new process starts with nothing in memory; only the device's storage is left.
  store.collapsedProjects = [];
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-testid=project-row][data-project-id="p-boite"]') !== null);
  expect(head('p-boite').getAttribute('aria-expanded')).toBe('false');
  expect(head('p-notes').getAttribute('aria-expanded')).toBe('true');

  // A project removed while the app was closed leaves the stored folds once the machine lists its projects.
  const key = Object.keys(localStorage).find((name) => name.startsWith('boite.foldedProjects.v1:'))!;
  localStorage.setItem(key, JSON.stringify(['p-boite', 'p-gone']));
  unmountApp();
  store.collapsedProjects = [];
  await mountOnFake();
  await waitFor(() => localStorage.getItem(key) === JSON.stringify(['p-boite']));
  expect(store.collapsedProjects).toEqual(['p-boite']);

  // Unfolding it is kept the same way.
  head('p-boite').click();
  await waitFor(() => head('p-boite').getAttribute('aria-expanded') === 'true');
  unmountApp();
  store.collapsedProjects = ['p-boite'];
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-testid=project-row][data-project-id="p-boite"]') !== null);
  expect(head('p-boite').getAttribute('aria-expanded')).toBe('true');
});

test('a notification link opens its thread on boot, with no landing draft first', async () => {
  const drafted = vi.spyOn(store, 'startDraft');
  try {
    await mountOnFake('/?fake=1&open=landing&thread=t-scheduler');
    expect(store.openThread?.id).toBe('t-scheduler');
    expect(drafted).not.toHaveBeenCalled();
    // A reload after the jump lands as usual instead of replaying the link.
    expect(new URLSearchParams(window.location.search).get('thread')).toBeNull();
  } finally { drafted.mockRestore(); }
});

test('a notification link to a thread that is gone lands on the usual draft', async () => {
  await mountOnFake('/?fake=1&open=landing&thread=t-gone');
  expect(store.openThread).toBeNull();
  expect(store.draft).not.toBeNull();
});

test('New thread opens a draft and the first send creates the thread titled from the prompt', async ({ app: _app }) => {

  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  // An empty draft is only the composer: the sidebar lists it once something is typed.
  expect(document.querySelector('[data-testid=draft-row]')).toBeNull();
  expect(store.openThread).toBeNull();

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Rename the scheduler caps\nand nothing else';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('[data-testid=draft-row]')?.textContent?.includes('Rename the scheduler caps') === true);
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.title).toBe('Rename the scheduler caps');
  expect(store.threads.length).toBe(5);
  await waitFor(() => store.openThread?.messages.length === 2);
  expect(store.openThread?.messages[0]?.role).toBe('user');
});

test('first run opens a draft in the drafts, and the first send makes them', async ({ app: _app }) => {
  await emptyCore();
  await waitFor(() => store.draft !== null);
  expect(store.draft?.projectId).toBeNull();
  expect(query('[data-testid=draft-project]').textContent).toContain('Drafts');
  // A draft in the drafts has no repository to branch.
  expect(document.querySelector('[data-testid=composer-worktree]')).toBeNull();

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Write a letter to the bank';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => store.openThread !== null && store.draft === null);
  const drafts = store.draftsProject;
  expect(drafts?.kind).toBe('drafts');
  expect(store.openThread?.projectId).toBe(drafts?.id);
  expect(store.openThread?.cwd).toMatch(/Documents\\Boite\\\d{4}-\d{2}-\d{2} Write a letter to the bank$/);
});

test('first run keeps opening a folder one click away', async ({ app: _app }) => {
  await emptyCore();
  await waitFor(() => document.querySelector('[data-testid=draft-open-folder]') !== null);
  query<HTMLButtonElement>('[data-testid=draft-open-folder]').click();
  await waitFor(() => document.querySelector('[data-testid=project-path]') !== null);
  await type(query<HTMLInputElement>('[data-testid=project-path]'), 'D:\\work\\first-project');
  query<HTMLButtonElement>('[data-testid=project-add]').click();
  await waitFor(() => store.openProject?.path === 'D:\\work\\first-project');
  expect(store.draftInDrafts).toBe(false);
  expect(document.querySelector('[data-testid=draft-open-folder]')).toBeNull();
});

test('not a developer, New thread still follows the project on screen', async ({ app: _app }) => {
  work.choose('everyday');
  // Work in two folders: each New thread stays in the folder on screen.
  await store.open('t-descriptors');
  store.startDraft();
  expect(store.draft?.projectId).toBe('p-notes');
  store.startDraft('p-boite');
  store.startDraft();
  expect(store.draft?.projectId).toBe('p-boite');
  // In the drafts, it stays in the drafts; with nothing on screen, the drafts too.
  store.startDraft(null);
  store.startDraft();
  expect(store.draftInDrafts).toBe(true);
  store.draft = null;
  store.startDraft();
  expect(store.draftInDrafts).toBe(true);
});

test('the title counts the threads that wait on the user or finished unread', async ({ app: _app }) => {
  await waitFor(() => /^\(\d+\) /.test(document.title));
  const waiting = document.querySelectorAll('[data-testid=sidebar] [data-state=waiting]').length;
  expect(Number(/^\((\d+)\)/.exec(document.title)?.[1])).toBeGreaterThanOrEqual(Math.max(1, waiting));
});
