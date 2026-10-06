import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';
import { workspace } from './lib/workspace.svelte';
import { writeExperiments } from './lib/experiments';
import { closeTour } from './lib/onboarding.svelte';
import { work } from './lib/work-prefs.svelte';
import { moveThread } from './lib/thread-move.svelte';

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

/** A mouse pointer event at a point: jsdom has no PointerEvent. */
function pointer(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerType: { value: 'mouse' }, pointerId: { value: 1 } });
  return event;
}

/** jsdom lays nothing out: the element "under" the pointer is whatever the test says. */
function under(element: () => Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => element() });
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

test('a row dragged with the mouse onto another project moves there; a short press, its own project and Escape do not', async () => {
  await mountOnFake();
  await waitFor(() => inProject('t-descriptors', 'p-notes'));
  const move = vi.spyOn(store, 'move');
  const notes = query('section[data-project-id="p-notes"]');
  const boite = query('section[data-project-id="p-boite"]');
  let target: Element | null = null;
  under(() => target);

  // A press that does not travel is a click: no drag, no move.
  card('t-descriptors').dispatchEvent(pointer('pointerdown', 10, 10));
  window.dispatchEvent(pointer('pointermove', 12, 11));
  expect(document.documentElement.classList.contains('thread-dragging')).toBe(false);
  window.dispatchEvent(pointer('pointerup', 12, 11));

  // Over its own project nothing is outlined; Escape drops the drag over another one.
  card('t-descriptors').dispatchEvent(pointer('pointerdown', 10, 10));
  target = notes.querySelector('[data-testid=project-row]');
  window.dispatchEvent(pointer('pointermove', 10, 40));
  await waitFor(() => card('t-descriptors').classList.contains('dragging'));
  expect(document.documentElement.classList.contains('thread-dragging')).toBe(true);
  expect(notes.classList.contains('drop')).toBe(false);
  // The row becomes a card under the mouse, which asks for another project; the projects it can land on show it.
  expect(query('[data-testid=thread-drag-ghost]').textContent).toContain('Drop on another project');
  expect(boite.classList.contains('candidate')).toBe(true);
  expect(notes.classList.contains('candidate')).toBe(false);
  target = boite;
  window.dispatchEvent(pointer('pointermove', 10, 80));
  await waitFor(() => boite.classList.contains('drop'));
  expect(query('[data-testid=thread-drag-hint]').textContent?.trim()).toBe('boite');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  await waitFor(() => !boite.classList.contains('drop'));
  window.dispatchEvent(pointer('pointerup', 10, 80));
  expect(move).not.toHaveBeenCalled();

  // Released over another project of its machine: the row moves there, and the click that ends the drag opens nothing.
  card('t-descriptors').dispatchEvent(pointer('pointerdown', 10, 10));
  window.dispatchEvent(pointer('pointermove', 10, 80));
  await waitFor(() => boite.classList.contains('drop'));
  window.dispatchEvent(pointer('pointerup', 10, 80));
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  query('[data-thread-id="t-descriptors"]').dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  await waitFor(() => inProject('t-descriptors', 'p-boite'));
  expect(move).toHaveBeenCalledWith('t-descriptors', 'p-boite', undefined);
  expect(boite.classList.contains('drop')).toBe(false);
  expect(document.documentElement.classList.contains('thread-dragging')).toBe(false);
  expect(document.querySelector('[data-testid=thread-drag-ghost]')).toBeNull();
});
test('a running thread stays draggable; its move asks first, waits for the turn, and Cancel move drops it', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-bench"]') !== null);
  // t-bench waits on a permission: its turn still runs.
  expect(card('t-bench').dataset['movable']).toBe('true');
  await workspace.select(store, 't-bench');
  await waitFor(() => store.openThread?.id === 't-bench');

  const answer = moveThread(store, 't-bench', 'p-notes');
  await waitFor(() => document.querySelector('[data-testid=confirm-ok]') !== null);
  expect(document.body.textContent).toContain('The thread moves to notes when the current turn ends.');
  expect(query('[data-testid=confirm-ok]').textContent?.trim()).toBe('Move after this turn');
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  expect(await answer).toBe(true);

  // The row stays where it is and says where it goes, and so does the header.
  await waitFor(() => card('t-bench').querySelector('[data-testid=thread-pending]') !== null);
  expect(inProject('t-bench', 'p-boite')).toBe(true);
  expect(card('t-bench').querySelector('[data-testid=thread-pending]')?.textContent?.trim()).toBe('Moves to notes after this turn');
  expect(query('[data-testid=thread-header] [data-testid=thread-pending]').getAttribute('title')).toBe('Moves to notes after this turn');

  query('[data-thread-id="t-bench"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=move-cancel]') !== null);
  expect(query<HTMLButtonElement>('[data-testid=context-menu] [data-value=move]').disabled).toBe(false);
  expect(query('[data-testid=context-menu] [data-value=move-cancel]').textContent?.trim()).toBe('Cancel move');
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=move-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=thread-pending]') === null);
  expect(store.threads.find((t) => t.id === 't-bench')?.pendingMove ?? null).toBeNull();
});

test('a working sub-thread keeps the move out, and a move asked anyway says to stop it first', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-descriptors"]') !== null);
  const parent = store.threads.find((t) => t.id === 't-descriptors')!;
  store.threads = [...store.threads, { ...parent, id: 't-child', title: 'child', parentThreadId: 't-descriptors', status: 'running' }];
  await waitFor(() => card('t-descriptors').dataset['movable'] === 'false');
  const move = vi.spyOn(store, 'move');
  expect(await moveThread(store, 't-descriptors', 'p-boite')).toBe(false);
  expect(move).not.toHaveBeenCalled();
  expect(store.error).toBe('A sub-thread is working; stop it before moving this thread');
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
  // Until the next prompt, the foot of the thread says the agent will be told, and what.
  await waitFor(() => document.querySelector('[data-testid=move-pending]') !== null);
  expect(query('[data-testid=move-pending]').textContent?.trim()).toBe('Moved to boite · the agent will be told with your next message');
  query<HTMLButtonElement>('[data-testid=move-pending-toggle]').click();
  await waitFor(() => document.querySelector('[data-testid=move-pending-note]') !== null);
  expect(query('[data-testid=move-pending-note]').textContent).toContain('Your working directory is now C:\\src\\boite.');
  expect(document.querySelector('[data-testid=move-marker]')).toBeNull();

  await store.client!.call('turns.start', { threadId: 't-descriptors', prompt: 'where am I' });
  await waitFor(() => document.querySelector('[data-testid=move-marker-toggle]') !== null);
  await waitFor(() => document.querySelector('[data-testid=move-pending]') === null);
  expect(query('[data-testid=move-marker]').textContent?.trim()).toBe('Move explained to the agent');
  query<HTMLButtonElement>('[data-testid=move-marker-toggle]').click();
  await waitFor(() => document.querySelector('[data-testid=move-note]') !== null);
  expect(query('[data-testid=move-note]').textContent).toContain('Your working directory is now C:\\src\\boite.');

  await waitFor(() => store.openThread?.status === 'idle');
  await store.client!.call('agent.move', { threadId: 't-descriptors', project: 'notes' });
  await waitFor(() => document.querySelector('[data-testid=move-marker][data-by=agent]') !== null);
  expect(query('[data-testid=move-marker][data-by=agent]').textContent?.trim()).toBe('Moved by the agent to notes');
  expect(document.querySelector('[data-testid=move-pending]')).toBeNull();
});

test('a move back to where the thread was takes the pending notice away', async () => {
  await mountOnFake();
  await workspace.select(store, 't-descriptors');
  await waitFor(() => store.openThread?.id === 't-descriptors');
  await moveThread(store, 't-descriptors', 'p-boite');
  await waitFor(() => document.querySelector('[data-testid=move-pending]') !== null);
  await moveThread(store, 't-descriptors', 'p-notes');
  await waitFor(() => store.openThread?.projectId === 'p-notes');
  await waitFor(() => document.querySelector('[data-testid=move-pending]') === null);
  expect(store.openThread?.moveNote ?? null).toBeNull();
});
