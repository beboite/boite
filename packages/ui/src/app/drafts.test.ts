import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { store } from '../lib/store.svelte';
import { mountOnFake, query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the draft worktree chip puts the first send on its own branch, and the header names it', async ({ app: _app }) => {

  // A thread keeps its directory: no chip while one is open.
  expect(document.querySelector('[data-testid=composer-worktree]')).toBeNull();

  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  const chip = query<HTMLButtonElement>('[data-testid=composer-worktree]');
  expect(chip.getAttribute('aria-pressed')).toBe('false');
  chip.click();
  await waitFor(() => store.draft?.worktree === true);
  expect(query<HTMLButtonElement>('[data-testid=composer-worktree]').getAttribute('aria-pressed')).toBe('true');

  // A worktree belongs to the project even before a provider is configured.
  const providers = store.providers;
  const draftChoice = store.draftChoice;
  try {
    store.providers = [];
    store.draftChoice = null;
    flushSync();
    expect(store.defaultChoice()).toBeNull();
    expect(query('[data-testid=draft-sentence]').textContent).toContain('in a worktree');
  } finally {
    store.providers = providers;
    store.draftChoice = draftChoice;
    flushSync();
  }

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Fix the login';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => store.openThread !== null && store.draft === null);
  const branch = store.openThread!.branch!;
  expect(branch).toMatch(/^boite\/wt-[a-z0-9]{8}$/);
  expect(store.openThread?.cwd).toBe(`C:\\src\\notes\\.boite\\worktrees\\${branch.slice(6)}`);
  await waitFor(() => document.querySelector('[data-testid=thread-branch]') !== null);
  expect(query('[data-testid=thread-branch]').textContent?.trim()).toBe(branch);
  expect(query('[data-testid=thread-branch]').title).toContain(branch.slice(6));
  // The chip went with the draft.
  expect(document.querySelector('[data-testid=composer-worktree]')).toBeNull();
  const cwd = store.openThread!.cwd;
  await waitFor(() => store.openThread?.turns.some(turn => turn.status === 'done') === true);
  await waitFor(() => query('[data-testid=thread-branch]').textContent?.trim() === 'boite/fix-the-login');
  expect(store.openThread?.cwd).toBe(cwd);
});

test('a draft offers the worktree switch only on a folder where git was found', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-worktree]') !== null);
  const project = store.projects.find((one) => one.id === store.draft?.projectId);
  if (!project) throw new Error('the draft has no project');
  project.repository = false;
  await waitFor(() => document.querySelector('[data-testid=composer-worktree]') === null);
  // No answer yet, or a core older than the field: no `.git` was found, so no switch either.
  delete project.repository;
  flushSync();
  expect(document.querySelector('[data-testid=composer-worktree]')).toBeNull();
  project.repository = true;
  await waitFor(() => document.querySelector('[data-testid=composer-worktree]') !== null);
});

test('a machine with no AI offers to connect one, and the composer keeps its text and lands on it', async () => {
  await mountOnFake('/?fake=1&uninstalled=1');
  if (!store.draft) query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-connect]') !== null);
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Sort my holiday photos';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  query<HTMLButtonElement>('[data-testid=composer-connect]').click();
  await waitFor(() => document.querySelector('[data-testid=connect-dialog]') !== null);
  // The two services most people already pay for come first, each saying which plan it uses.
  const services = Array.from(document.querySelectorAll('[data-testid=connect-service]')).map((row) => row.getAttribute('data-provider'));
  expect(services.slice(0, 2)).toEqual(['claude', 'codex']);
  expect(query('[data-testid=connect-dialog]').textContent).toContain('Uses a Claude Pro or Max plan');

  query<HTMLButtonElement>('[data-testid=connect-service][data-provider=claude]').click();
  await waitFor(() => document.querySelector('[data-testid=connect-install]') !== null);
  query<HTMLButtonElement>('[data-testid=connect-install]').click();
  // The download chains into the sign-in, which hands over a page to open and a field for its code.
  await waitFor(() => document.querySelector('[data-testid=connect-login-url]') !== null, 20_000);
  const code = query<HTMLInputElement>('[data-testid=connect-login-input]');
  code.value = 'fake-code';
  code.dispatchEvent(new Event('input', { bubbles: true }));
  code.closest('form')!.requestSubmit();
  await waitFor(() => document.querySelector('[data-testid=connect-use]') !== null, 20_000);
  await store.reloadProviders();
  expect(store.accountsOf('claude')).toEqual([
    expect.objectContaining({ label: 'Claude', status: 'ok', isolationDir: expect.any(String) })
  ]);
  query<HTMLButtonElement>('[data-testid=connect-use]').click();

  await waitFor(() => document.querySelector('[data-testid=connect-dialog]') === null);
  await waitFor(() => document.querySelector('[data-testid=composer-connect]') === null);
  expect(query('[data-testid=composer-picker]').textContent).not.toContain('No AI connected');
  expect(query<HTMLTextAreaElement>('[data-testid=composer-input]').value).toBe('Sort my holiday photos');
});

test('the keyboard stays in the connect dialog while its steps replace the button it pressed', async () => {
  await mountOnFake('/?fake=1&uninstalled=1');
  if (!store.draft) query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-connect]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-connect]').click();
  await waitFor(() => document.querySelector('[data-testid=connect-service]') !== null);
  query<HTMLButtonElement>('[data-testid=connect-service][data-provider=claude]').click();
  await waitFor(() => document.querySelector('[data-testid=connect-install]') !== null);
  const install = query<HTMLButtonElement>('[data-testid=connect-install]');
  install.focus();
  install.click();
  const dialog = () => query('[data-testid=connect-dialog]');
  await waitFor(() => document.querySelector('[data-testid=connect-step]')?.getAttribute('data-step') === 'installing');
  await waitFor(() => dialog().contains(document.activeElement));
  await waitFor(() => document.querySelector('[data-testid=connect-login-url]') !== null, 20_000);
  await waitFor(() => dialog().contains(document.activeElement));
  const code = query<HTMLInputElement>('[data-testid=connect-login-input]');
  code.focus();
  code.value = 'fake-code';
  code.dispatchEvent(new Event('input', { bubbles: true }));
  code.closest('form')!.requestSubmit();
  await waitFor(() => document.querySelector('[data-testid=connect-use]') !== null, 20_000);
  await waitFor(() => document.activeElement === document.querySelector('[data-testid=connect-use]'));
  query<HTMLButtonElement>('[data-testid=connect-use]').click();
  await waitFor(() => document.querySelector('[data-testid=connect-dialog]') === null);
}, 30_000);

test('the sidebar draft row hands the keyboard back to the composer', async ({ app: _app }) => {

  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  // The row appears with the first typed text.
  store.editComposerText('draft', 'Half a thought');
  await waitFor(() => document.querySelector('[data-testid=draft-row]') !== null);

  // Something else in the page holds the keyboard, the way it does after a click.
  const gear = query<HTMLButtonElement>('[data-testid=nav-settings]');
  gear.focus();
  expect(document.activeElement).toBe(gear);

  query<HTMLButtonElement>('[data-testid=draft-row]').click();
  await waitFor(
    () => document.activeElement === document.querySelector('[data-testid=composer-input]')
  );
  expect(store.draft).not.toBeNull();

  // The store is the singleton every test shares: the draft goes back out.
  store.editComposerText('draft', '');
  store.draft = null;
});

test('a draft names its project in the heading and the dropdown moves it to another one', async ({ app: _app }) => {

  // The one plus left says where it will open the draft, and a project row has none.
  expect(query<HTMLButtonElement>('[data-testid=new-thread]').title).toBe('New thread in notes (Ctrl+N)');
  expect(document.querySelector('[data-testid=project-new-thread]')).toBeNull();

  // The draft opens in the project of the thread that was open, `notes`.
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  const heading = query('[data-testid=draft-sentence]');
  expect(heading.querySelector('p')?.textContent).toContain('with approval requests');
  expect(heading.querySelector('h1')?.textContent).toContain('notes');
  // The heading says the project, so the header chip no longer repeats it.
  expect(query('[data-testid=thread-header]').textContent).not.toContain('notes');

  query<HTMLButtonElement>('[data-testid=draft-project]').click();
  await waitFor(() => document.querySelector('[data-testid=draft-project-menu]') !== null);
  const rows = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid=draft-project-menu] [data-row]')
  );
  // The drafts lead, made or not, and opening a folder closes the list.
  const places = rows.filter((row) => row.dataset['value']!.startsWith('['));
  expect(places.map((row) => JSON.parse(row.dataset['value']!)[1])).toEqual([null, 'p-boite', 'p-notes']);
  expect(rows.at(-1)?.dataset['value']).toBe('open-folder');

  // The search narrows the list by name or path, says when nothing matches,
  // and Enter takes the first row left.
  const search = query<HTMLInputElement>('[data-testid=draft-project-search]');
  const typeQuery = (text: string) => { search.value = text; search.dispatchEvent(new Event('input', { bubbles: true })); flushSync(); };
  const shownValues = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid=draft-project-list] [data-row]')).map((row) => row.dataset['value']);
  typeQuery('zzz');
  expect(shownValues()).toEqual([]);
  expect(query('[data-testid=draft-project-empty]').textContent).toContain('zzz');
  typeQuery('BOI');
  expect(shownValues().map((value) => JSON.parse(value!)[1])).toEqual(['p-boite']);

  // Enter that confirms an input method's candidate picks nothing.
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  flushSync();
  expect(document.querySelector('[data-testid=draft-project-menu]')).not.toBeNull();
  expect(store.draft?.projectId).toBe('p-notes');

  store.editComposerText('draft', 'Move me along');
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => store.draft?.projectId === 'p-boite');
  await waitFor(() => document.querySelector('[data-testid=draft-project-menu]') === null);
  await waitFor(() => (query('[data-testid=draft-empty]').textContent ?? '').includes('boite'));
  // The draft row moved with it, and the composer took the keyboard back.
  await waitFor(() => query('[data-testid=project][data-project-id=p-boite]').querySelector('[data-testid=draft-row]') !== null);
  expect(query('[data-testid=project][data-project-id=p-notes]').querySelector('[data-testid=draft-row]')).toBeNull();
  await waitFor(() => document.activeElement === document.querySelector('[data-testid=composer-input]'));

  // Focus back on the trigger, Escape still closes the list.
  const trigger = query<HTMLButtonElement>('[data-testid=draft-project]');
  trigger.click();
  await waitFor(() => document.querySelector('[data-testid=draft-project-menu]') !== null);
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => document.querySelector('[data-testid=draft-project-menu]') === null);

  // The store is the singleton every test shares: the draft goes back out.
  store.editComposerText('draft', '');
  store.draft = null;
});
