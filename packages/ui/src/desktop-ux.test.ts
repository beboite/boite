import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';
import { workspace } from './lib/workspace.svelte';
import { writeExperiments } from './lib/experiments';
import { closeTour } from './lib/onboarding.svelte';
import { work } from './lib/work-prefs.svelte';
import { archiveThread } from './lib/archive';
import { runCommand } from './lib/commands.svelte';
import { undo } from './lib/undo.svelte';

/**
 * The desktop behaviours the UX audit found broken, on the whole app over the
 * in-memory fake: Escape that closed a popover also stopped the turn, archive
 * and machine removal went through at one click, a failed Settings save said
 * "Saved", and the sidebar neither floated live threads nor stopped repeating
 * the project under its own header.
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
  undo.dismiss();
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

function press(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function mountOnFake(search = '/?fake=1'): Promise<void> {
  window.history.replaceState(null, '', search.includes('open=') ? search : `${search}&open=recent`);
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
}

test('Escape on an open context popover closes it and leaves a busy turn running', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-testid=context-trigger]') !== null);
  query<HTMLButtonElement>('[data-testid=context-trigger]').click();
  await waitFor(() => document.querySelector('[data-testid=context-popup]') !== null);
  vi.spyOn(store, 'busy', 'get').mockReturnValue(true);
  const stop = vi.spyOn(store, 'stop').mockResolvedValue(undefined as never);
  press(document.body, 'Escape');
  flushSync();
  expect(stop).not.toHaveBeenCalled();
  await waitFor(() => query('[data-testid=context-trigger]').getAttribute('aria-expanded') === 'false');
});

test('leaving a header rename with Escape hands the focus back to the title, not the page', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=thread-title]').click();
  await waitFor(() => document.querySelector('[data-testid=thread-rename-input]') !== null);
  press(query('[data-testid=thread-rename-input]'), 'Escape');
  await waitFor(() => document.activeElement?.getAttribute('data-testid') === 'thread-title');
});

test('archiving a thread that waits on the user asks first; cancel keeps it', async () => {
  await mountOnFake();
  await waitFor(() => store.pendingPermissions.some((p) => p.threadId === 't-bench'));
  const archive = vi.spyOn(store, 'archive');
  const answer = archiveThread(store, 't-bench');
  await waitFor(() => document.querySelector('[data-testid=confirm-cancel]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  expect(await answer).toBe(false);
  expect(archive).not.toHaveBeenCalled();
  expect(store.threads.find((t) => t.id === 't-bench')?.archived).toBe(false);
});

test('Escape on the archive confirmation keeps the thread and hands the keyboard back to what had it', async () => {
  await mountOnFake();
  await waitFor(() => store.pendingPermissions.some((p) => p.threadId === 't-bench'));
  const title = query('[data-testid=thread-title]');
  title.focus();
  const answer = archiveThread(store, 't-bench');
  await waitFor(() => document.activeElement?.getAttribute('data-testid') === 'confirm-cancel');
  vi.spyOn(store, 'busy', 'get').mockReturnValue(true);
  const stop = vi.spyOn(store, 'stop').mockResolvedValue(undefined as never);
  press(document.activeElement!, 'Escape');
  expect(await answer).toBe(false);
  await waitFor(() => document.activeElement === title);
  flushSync();
  expect(stop).not.toHaveBeenCalled();
});

test('a thread row menu closed with Escape, or by a pick whose dialog is cancelled, hands the keyboard back to its button', async () => {
  await mountOnFake();
  await waitFor(() => store.pendingPermissions.some((p) => p.threadId === 't-bench'));
  await waitFor(() => document.querySelector('[data-testid=thread-row][data-thread-id=t-bench]') !== null);
  const button = query('[data-testid=thread-row][data-thread-id=t-bench]').parentElement!.querySelector<HTMLButtonElement>('[data-testid=thread-menu]')!;
  const firstRow = () => document.querySelector<HTMLElement>('[data-testid=context-menu] [data-row]');
  button.focus();
  button.click();
  await waitFor(() => firstRow() !== null && firstRow() === document.activeElement);
  vi.spyOn(store, 'busy', 'get').mockReturnValue(true);
  const stop = vi.spyOn(store, 'stop').mockResolvedValue(undefined as never);
  press(document.activeElement!, 'Escape');
  await waitFor(() => document.activeElement === button);
  flushSync();
  expect(stop).not.toHaveBeenCalled();

  button.click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=archive]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archive]').click();
  await waitFor(() => document.activeElement?.getAttribute('data-testid') === 'confirm-cancel');
  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null || document.activeElement === button);
  await waitFor(() => document.activeElement === button);
  expect(store.threads.find((t) => t.id === 't-bench')?.archived).toBe(false);
});

test('an archived thread comes back from Settings > General', async () => {
  await mountOnFake();
  expect(await archiveThread(store, 't-trace')).toBe(true);
  await waitFor(() => !store.threads.some((t) => t.id === 't-trace' && !t.archived));
  store.showSettings('general');
  await waitFor(() => document.querySelector('[data-testid=archived-show]') !== null);
  query<HTMLButtonElement>('[data-testid=archived-show]').click();
  await waitFor(() => document.querySelector('[data-testid=archived-restore]') !== null);
  expect(query('[data-testid=archived-list]').textContent).toContain('Finish the trace tab');
  query<HTMLButtonElement>('[data-testid=archived-restore]').click();
  await waitFor(() => store.threads.find((t) => t.id === 't-trace')?.archived === false);
  // The row stays, its button now Open, which lands in the thread.
  await waitFor(() => document.querySelector('[data-testid=archived-open]') !== null);
  query<HTMLButtonElement>('[data-testid=archived-open]').click();
  await waitFor(() => store.page === 'chat' && store.openThread?.id === 't-trace');
});

test('the palette and the project menu reach the archive, its list already read', async () => {
  // A jump to a card scrolls it into view, which jsdom does not draw.
  Element.prototype.scrollIntoView ??= vi.fn();
  await mountOnFake();
  expect(await archiveThread(store, 't-trace')).toBe(true);
  await waitFor(() => !store.threads.some((t) => t.id === 't-trace' && !t.archived));
  runCommand(store, 'archived', false);
  await waitFor(() => document.querySelector('[data-testid=archived-list]') !== null);
  expect(document.querySelector('[data-testid=archived-show]')).toBeNull();
  expect(query('[data-testid=archived-list]').textContent).toContain('Finish the trace tab');

  store.showChat();
  await waitFor(() => document.querySelector('[data-testid=project-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=project-menu]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=archived]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archived]').click();
  await waitFor(() => store.page === 'settings' && document.querySelector('[data-testid=archived-list]') !== null);
});

test('Ctrl+Shift+T brings back the threads archived here, newest first, and opens each', async () => {
  await mountOnFake();
  expect(await archiveThread(store, 't-trace')).toBe(true);
  expect(await archiveThread(store, 't-descriptors')).toBe(true);
  await waitFor(() => !store.threads.some((t) => (t.id === 't-trace' || t.id === 't-descriptors') && !t.archived));

  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => store.openThread?.id === 't-descriptors');
  expect(store.threads.find((t) => t.id === 't-descriptors')?.archived).toBe(false);

  runCommand(store, 'reopen-thread', false);
  await waitFor(() => store.openThread?.id === 't-trace');
  expect(store.threads.find((t) => t.id === 't-trace')?.archived).toBe(false);
});

test('the scheduler never says Saved after a refused save, and refuses an out-of-range value itself', async () => {
  await mountOnFake();
  store.showSettings('advanced');
  await waitFor(() => document.querySelector('[data-testid=scheduler-save]') !== null);
  const field = query<HTMLInputElement>('[data-testid=setting-maxConcurrentTurns]');
  field.value = '0';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('[data-testid=setting-error-maxConcurrentTurns]') !== null);
  expect(query<HTMLButtonElement>('[data-testid=scheduler-save]').disabled).toBe(true);

  field.value = '7';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=scheduler-save]').disabled);
  const call = store.client!.call.bind(store.client!);
  vi.spyOn(store.client!, 'call').mockImplementation((async (method: string, params: never) => {
    if (method === 'settings.set') throw new Error('settings.set refused');
    return call(method as never, params);
  }) as never);
  query<HTMLButtonElement>('[data-testid=scheduler-save]').click();
  await waitFor(() => store.error !== null);
  flushSync();
  expect(document.querySelector('[data-testid=scheduler-saved]')).toBeNull();
});

test('the LAN switch saves when it flips, like every other switch in Settings', async () => {
  await mountOnFake();
  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=setting-listen-on-lan]') !== null);
  const before = store.settings?.listenOnLan ?? false;
  query<HTMLInputElement>('[data-testid=setting-listen-on-lan]').click();
  await waitFor(() => store.settings?.listenOnLan === !before);
});

test('removing a machine asks first, and cancel keeps its card', async () => {
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2);
  store.showSettings('machines');
  await waitFor(() => document.querySelectorAll('[data-testid=machine-card]').length === 2);
  const remove = query<HTMLButtonElement>('[data-testid=machine-remove]');
  remove.focus();
  remove.click();
  await waitFor(() => document.activeElement?.getAttribute('data-testid') === 'confirm-cancel');
  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.activeElement === remove);
  expect(workspace.machines).toHaveLength(2);
  expect(document.querySelectorAll('[data-testid=machine-card]')).toHaveLength(2);
});

test('the sidebar floats a thread that waits on the user, in both views, and names the project only in Recent', async () => {
  await mountOnFake();
  workspace.view = 'projects';
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length >= 2);
  const rows = () => Array.from(document.querySelectorAll('[data-testid=thread-row]')).map((row) => row.getAttribute('data-thread-id'));
  const project = store.projects.find((p) => store.threadsOf(p.id).length >= 2)!;
  const rowsOf = () => rows().filter((id) => store.threads.find((t) => t.id === id)?.projectId === project.id);
  // The fake seeds threads that already wait on a question; start from a quiet project.
  for (const thread of store.threadsOf(project.id)) thread.status = 'idle';
  await waitFor(() => rowsOf().length >= 2);
  const last = rowsOf().at(-1)!;
  expect(rowsOf()[0]).not.toBe(last);
  store.threads.find((t) => t.id === last)!.status = 'waiting';
  await waitFor(() => rowsOf()[0] === last);
  expect(document.querySelector('[data-testid=thread-project]')).toBeNull();

  workspace.view = 'recent';
  await waitFor(() => rows()[0] === last);
  expect(document.querySelectorAll('[data-testid=thread-project]').length).toBe(rows().length);
});

test('an archive offers its way back for a moment: the toast button, or Ctrl+Z outside a field', async () => {
  await mountOnFake();
  expect(await archiveThread(store, 't-trace')).toBe(true);
  await waitFor(() => document.querySelector('[data-testid=undo-toast]') !== null);
  expect(query('[data-testid=undo-toast]').textContent).toContain('Finish the trace tab');
  query<HTMLButtonElement>('[data-testid=undo-action]').click();
  await waitFor(() => store.threads.find((t) => t.id === 't-trace')?.archived === false);
  await waitFor(() => document.querySelector('[data-testid=undo-toast]') === null);

  expect(await archiveThread(store, 't-trace')).toBe(true);
  await waitFor(() => !store.threads.some((t) => t.id === 't-trace'));
  // In the composer, Ctrl+Z is the text's own undo.
  const box = document.querySelector('textarea');
  if (box) {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.threads.some((t) => t.id === 't-trace')).toBe(false);
  }
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => store.threads.find((t) => t.id === 't-trace')?.archived === false);
});

test('a thread left with words in its box carries a draft mark on its row, the open one none', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length >= 2);
  const first = store.openThread!.id;
  store.composerStates[first] = { text: 'half a thought', attachments: [], queued: [], sending: false, paused: false };
  flushSync();
  const rowOf = (id: string) => query(`[data-testid=thread-row][data-thread-id="${id}"]`);
  expect(rowOf(first).querySelector('[data-testid=thread-draft]')).toBeNull();
  const other = store.threads.find((t) => t.id !== first && document.querySelector(`[data-testid=thread-row][data-thread-id="${t.id}"]`))!;
  await workspace.select(store, other.id);
  await waitFor(() => rowOf(first).querySelector('[data-testid=thread-draft]') !== null);
  expect(rowOf(first).querySelector('[data-testid=thread-draft]')!.getAttribute('title')).toBe('Unsent draft');
  // Only words count: a box emptied back to spaces is no draft.
  store.composerStates[first]!.text = '   ';
  await waitFor(() => rowOf(first).querySelector('[data-testid=thread-draft]') === null);
});

test('a folded project keeps saying what its hidden threads do, and the mark goes when it unfolds', async () => {
  await mountOnFake();
  workspace.view = 'projects';
  const project = store.projects.find((p) => store.threadsOf(p.id).length >= 2)!;
  for (const thread of store.threadsOf(project.id)) { thread.status = 'idle'; thread.unread = false; }
  const head = () => query(`[data-testid=project-row][data-project-id="${project.id}"]`);
  await waitFor(() => document.querySelector(`[data-testid=project-row][data-project-id="${project.id}"]`) !== null);
  if (!store.isCollapsed(project.id)) store.toggleProject(project.id);
  flushSync();
  expect(head().querySelector('[data-testid=project-rollup]')).toBeNull();
  const [first, second] = store.threadsOf(project.id);
  first!.status = 'running';
  second!.status = 'waiting';
  await waitFor(() => head().querySelector('[data-testid=project-rollup]')?.getAttribute('data-state') === 'waiting');
  expect(head().querySelector('[data-testid=project-rollup]')!.getAttribute('title')).toBe('1 thread: Needs you');
  store.toggleProject(project.id);
  await waitFor(() => head().querySelector('[data-testid=project-rollup]') === null);
});

async function openIdleThread(): Promise<string> {
  await mountOnFake();
  await workspace.select(store, 't-descriptors');
  await waitFor(() => store.openThread?.id === 't-descriptors' && !store.busy && document.querySelectorAll('[data-testid=message][data-role=user]').length > 0);
  return 't-descriptors';
}

function userTexts(): string[] {
  return (store.openThread?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
}

test('Edit on a sent prompt fills the box in edit mode; sending replaces it and what followed', async () => {
  await openIdleThread();
  const before = userTexts();
  const first = query('[data-testid=message][data-role=user]');
  query<HTMLButtonElement>('[data-testid=message][data-role=user] [data-testid=message-edit]').click();
  flushSync();
  const box = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  await waitFor(() => box.value === before[0]);
  expect(first).toBeTruthy();
  expect(query('[data-testid=composer-editing]').textContent).toContain('Editing a sent message');
  box.value = 'Does an unknown field refuse the file, and say which?';
  box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  press(box, 'Enter');
  await waitFor(() => userTexts()[0] === 'Does an unknown field refuse the file, and say which?');
  // The edited prompt took the place of the first one: nothing of the old thread follows it.
  expect(userTexts().filter((text) => before.includes(text))).toEqual([]);
  await waitFor(() => document.querySelector('[data-testid=composer-editing]') === null);
});

test('ArrowUp in an empty box of a thread at rest recalls the last prompt to edit, Escape leaves it untouched', async () => {
  await openIdleThread();
  const before = userTexts();
  const box = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  box.focus();
  press(box, 'ArrowUp');
  flushSync();
  await waitFor(() => document.querySelector('[data-testid=composer-editing]') !== null);
  expect(box.value).toBe(before.at(-1));
  press(box, 'Escape');
  flushSync();
  await waitFor(() => document.querySelector('[data-testid=composer-editing]') === null);
  expect(box.value).toBe('');
  expect(userTexts()).toEqual(before);
});

test('fork from an answer opens a new thread holding the history, the source untouched', async () => {
  await openIdleThread();
  const before = userTexts();
  query<HTMLButtonElement>('[data-testid=turn-summary] [data-testid=message-fork]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=here]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=here]').click();
  await waitFor(() => store.openThread !== null && store.openThread.id !== 't-descriptors');
  expect(store.openThread!.title).toMatch(/\(fork\)$/);
  expect(userTexts()).toEqual(before.slice(0, 1));
  expect(store.threads.some((t) => t.id === 't-descriptors')).toBe(true);
});

test('retry sits on the last finished turn only and sends its prompt again in place of the answer', async () => {
  await openIdleThread();
  const box = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  box.value = 'And the roots entry outside the folder?';
  box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  press(box, 'Enter');
  await waitFor(() => document.querySelectorAll('[data-testid=turn-summary][data-status=done]').length >= 2 && !store.busy);
  const before = userTexts();
  const answered = store.openThread!.turns.at(-1)!.id;
  const summaries = document.querySelectorAll('[data-testid=turn-summary]');
  expect(summaries[0]!.querySelector('[data-testid=message-retry]')).toBeNull();
  (summaries[summaries.length - 1]!.querySelector('[data-testid=message-retry]') as HTMLButtonElement).click();
  // A new turn in place of the old one, on the same prompt.
  await waitFor(() => store.openThread?.turns.at(-1)?.id !== answered && store.openThread?.turns.at(-1)?.status === 'done');
  expect(userTexts()).toEqual(before);
  expect(store.openThread!.turns.some((turn) => turn.id === answered)).toBe(false);
});
