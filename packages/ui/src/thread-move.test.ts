import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';
import { workspace } from './lib/workspace.svelte';
import { writeExperiments } from './lib/experiments';
import { closeTour } from './lib/onboarding.svelte';
import { work } from './lib/work-prefs.svelte';
import { moveThread, THREAD_DRAG_TYPE } from './lib/thread-move.svelte';

/*
 * Moving a thread to another project from the whole app over the in-memory
 * fake: the row menu and its project picker, a drag onto a project, the
 * background work question, and the two timeline markers.
 */

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

let running: Record<string, unknown> | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  writeExperiments([]);
  window.localStorage.clear();
  work.load();
  workspace.view = 'projects';
});

async function waitFor(check: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

async function mountOnFake(search = '/?fake=1&open=recent'): Promise<void> {
  window.history.replaceState(null, '', search);
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.page = 'chat';
  store.composerStates = {};
  store.projectPickerOpen = false;
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));
  workspace.view = 'projects';
}

/** A drag event carrying a stand-in DataTransfer: jsdom has none. */
function drag(type: string, types: string[] = [THREAD_DRAG_TYPE]): DragEvent {
  const data = new Map<string, string>();
  const transfer = {
    types,
    effectAllowed: 'all',
    dropEffect: 'none',
    setData: (kind: string, value: string) => data.set(kind, value),
    getData: (kind: string) => data.get(kind) ?? '',
  };
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return event;
}

const card = (threadId: string) => query(`[data-thread-id="${threadId}"]`).closest('.thread') as HTMLElement;
const inProject = (threadId: string, projectId: string) =>
  document.querySelector(`section[data-project-id="${projectId}"] [data-thread-id="${threadId}"]`) !== null;

test('the row menu opens a picker of the other projects, and a pick moves the row there', async () => {
  await mountOnFake();
  await waitFor(() => inProject('t-descriptors', 'p-notes'));
  query('[data-thread-id="t-descriptors"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=move]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=move]').click();

  // The picker replaces the menu where it stood: every project but the thread's own.
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=p-boite]') !== null);
  const rows = Array.from(document.querySelectorAll('[data-testid=context-menu] [data-row]')).map((el) => el.textContent?.trim());
  expect(rows).toEqual(['boite C:\\src\\boite']);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=p-boite]').click();

  await waitFor(() => inProject('t-descriptors', 'p-boite'));
  expect(store.threads.find((t) => t.id === 't-descriptors')).toMatchObject({ projectId: 'p-boite', cwd: 'C:\\src\\boite' });
});

test('a row dropped on another project moves there; its own project and a foreign drag are ignored', async () => {
  await mountOnFake();
  await waitFor(() => inProject('t-descriptors', 'p-notes'));
  const move = vi.spyOn(store, 'move');
  const notes = query('section[data-project-id="p-notes"]');
  const boite = query('section[data-project-id="p-boite"]');

  // Something else dragged over the sidebar (a file) is not a thread.
  const file = drag('dragover', ['Files']);
  boite.dispatchEvent(file);
  expect(file.defaultPrevented).toBe(false);

  const start = drag('dragstart');
  card('t-descriptors').dispatchEvent(start);
  expect(start.dataTransfer?.getData(THREAD_DRAG_TYPE)).toContain('t-descriptors');

  const home = drag('dragover');
  notes.dispatchEvent(home);
  expect(home.defaultPrevented).toBe(false);

  const over = drag('dragover');
  boite.dispatchEvent(over);
  expect(over.defaultPrevented).toBe(true);
  await waitFor(() => boite.classList.contains('drop'));

  boite.dispatchEvent(drag('drop'));
  await waitFor(() => inProject('t-descriptors', 'p-boite'));
  expect(move).toHaveBeenCalledWith('t-descriptors', 'p-boite', undefined);
  expect(boite.classList.contains('drop')).toBe(false);
});

test('a running thread cannot be dragged, and a move asked anyway says to stop it first', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-bench"]') !== null);
  expect(card('t-bench').getAttribute('draggable')).toBe('false');
  const move = vi.spyOn(store, 'move');
  expect(await moveThread(store, 't-bench', 'p-notes')).toBe(false);
  expect(move).not.toHaveBeenCalled();
  expect(store.error).toBe('Stop the turn before moving this thread');
  store.error = null;
});

test('a thread with a monitor asks Stop monitors or Keep them, and Keep leaves it running', async () => {
  await mountOnFake();
  const client = store.client!;
  const turn = await client.call('turns.start', { threadId: 't-descriptors', prompt: '[monitor]' });
  await waitFor(() => store.threads.find((t) => t.id === 't-descriptors')?.backgroundWork?.kinds.includes('monitor') === true && store.threads.find((t) => t.id === 't-descriptors')?.status === 'idle');
  expect(turn.threadId).toBe('t-descriptors');

  const move = vi.spyOn(store, 'move');
  const answer = moveThread(store, 't-descriptors', 'p-boite');
  await waitFor(() => document.querySelector('[data-testid=confirm-alt]') !== null);
  expect(query('[data-testid=confirm-ok]').textContent?.trim()).toBe('Stop monitors');
  expect(query('[data-testid=confirm-alt]').textContent?.trim()).toBe('Keep them');
  query<HTMLButtonElement>('[data-testid=confirm-alt]').click();
  expect(await answer).toBe(true);
  expect(move).toHaveBeenCalledWith('t-descriptors', 'p-boite', false);
  expect(store.threads.find((t) => t.id === 't-descriptors')?.backgroundWork?.kinds).toEqual(['monitor']);
});

test('the next prompt shows the accent marker that opens on the note; an agent move shows its own line', async () => {
  await mountOnFake();
  await workspace.select(store, 't-descriptors');
  await waitFor(() => store.openThread?.id === 't-descriptors');
  await moveThread(store, 't-descriptors', 'p-boite');
  await store.client!.call('turns.start', { threadId: 't-descriptors', prompt: 'where am I' });
  await waitFor(() => document.querySelector('[data-testid=move-marker-toggle]') !== null);
  expect(query('[data-testid=move-marker]').textContent?.trim()).toBe('Move explained to the agent');
  query<HTMLButtonElement>('[data-testid=move-marker-toggle]').click();
  await waitFor(() => document.querySelector('[data-testid=move-note]') !== null);
  expect(query('[data-testid=move-note]').textContent).toContain('Your working directory is now C:\\src\\boite.');

  await waitFor(() => store.openThread?.status === 'idle');
  await store.client!.call('agent.move', { threadId: 't-descriptors', project: 'notes' });
  await waitFor(() => document.querySelector('[data-testid=move-marker][data-by=agent]') !== null);
  expect(query('[data-testid=move-marker][data-by=agent]').textContent?.trim()).toBe('Moved by the agent to notes');
});
