import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';
import { workspace } from './lib/workspace.svelte';
import { writeExperiments } from './lib/experiments';
import { closeTour } from './lib/onboarding.svelte';
import { work } from './lib/work-prefs.svelte';
import { archiveThread } from './lib/archive';

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
  await waitFor(() => document.querySelector('[data-testid=archived-empty]') !== null);
});

test('the scheduler never says Saved after a refused save, and refuses an out-of-range value itself', async () => {
  await mountOnFake();
  store.showSettings('general');
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
  store.showSettings('general');
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
  query<HTMLButtonElement>('[data-testid=machine-remove]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-cancel]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
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
