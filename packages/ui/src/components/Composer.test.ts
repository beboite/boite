import { afterEach, expect, test } from 'vitest';
import { mount, unmount } from 'svelte';
import App from '../App.svelte';
import { STASH_STORAGE_KEY } from '../lib/prefs';
import { store } from '../lib/store.svelte';

/**
 * The three composer keys, on the whole app over the in-memory fake: Ctrl+Enter
 * sends and opens the next draft, ArrowUp walks this thread's sent prompts, and
 * Ctrl+S puts the text aside and takes it back.
 */

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

async function waitFor(check: () => boolean, attempts = 400): Promise<void> {
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

function input(): HTMLTextAreaElement {
  return query<HTMLTextAreaElement>('[data-testid=composer-input]');
}

/** A key on whatever holds the focus; false back means something took it. */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const target = document.activeElement ?? document.body;
  return target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  );
}

/** Type into the composer the way a user does, then let the effects settle. */
async function type(text: string): Promise<void> {
  const field = input();
  field.focus();
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountOnFake(): Promise<void> {
  window.history.replaceState(null, '', '/?fake=1');
  const target = document.createElement('div');
  document.body.appendChild(target);
  // The store is a singleton: the previous test's thread and its draft would
  // otherwise stand, and a boot that already has one opens nothing.
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  running = mount(App, { target });
  await waitFor(() => store.booted && store.openThread !== null);
}

/** One finished turn on the thread that is open, sent from the composer. */
async function send(prompt: string): Promise<void> {
  await waitFor(() => !store.busy);
  const before = store.openThread?.messages.length ?? 0;
  await type(prompt);
  input().focus();
  press('Enter');
  await waitFor(() => (store.openThread?.messages.length ?? 0) >= before + 2 && !store.busy);
}

test('Ctrl+Enter sends and leaves a fresh draft open on the same picker values', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);
  const thread = store.openThread;
  if (!thread) throw new Error('no open thread');
  const before = store.threads.length;

  await type('Send this one and give me the next box');
  input().focus();
  expect(press('Enter', { ctrlKey: true })).toBe(false);

  await waitFor(() => store.draft !== null && store.openThread === null);
  // The prompt went into the thread it was typed in, and no thread was created.
  expect(store.threads.length).toBe(before);
  const sentTo = await store.client?.call('threads.get', { threadId: 't-trace' });
  expect(sentTo?.messages.filter((m) => m.role === 'user').at(-1)?.parts).toEqual([
    { type: 'text', text: 'Send this one and give me the next box' }
  ]);

  // The draft sits in the same project, on the same five values, and the
  // composer has the keyboard, exactly like Ctrl+N.
  expect(store.draft?.projectId).toBe(thread.projectId);
  expect(store.defaultChoice()).toEqual({
    providerId: thread.providerId,
    accountId: thread.accountId,
    permissionMode: thread.permissionMode,
    model: thread.model,
    effort: thread.effort
  });
  expect(input().value).toBe('');
  await waitFor(() => document.activeElement === input());

  // The same key on that draft: the thread is created first, then the next draft.
  await type('And one more thread');
  input().focus();
  press('Enter', { ctrlKey: true });
  await waitFor(() => store.threads.length === before + 1);
  await waitFor(() => store.draft !== null && store.openThread === null);
  expect(store.threads.at(-1)?.title).toBe('And one more thread');
  expect(store.draft?.projectId).toBe(thread.projectId);
});

test('ArrowUp recalls the sent prompts of this thread and ArrowDown comes back', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);

  await send('the older one');
  await send('the newer one');
  await waitFor(() => input().value === '');

  input().focus();
  expect(press('ArrowUp')).toBe(false);
  expect(input().value).toBe('the newer one');
  // The caret sits at the end of what was recalled.
  expect(input().selectionStart).toBe('the newer one'.length);

  press('ArrowUp');
  expect(input().value).toBe('the older one');

  // One older again is the prompt the thread was seeded with.
  press('ArrowUp');
  expect(input().value).toBe('What does the trace tab need from the core?');
  // Nothing older: the oldest stays, and the caret does not run off.
  press('ArrowUp');
  expect(input().value).toBe('What does the trace tab need from the core?');

  press('ArrowDown');
  expect(input().value).toBe('the older one');
  press('ArrowDown');
  expect(input().value).toBe('the newer one');
  // Past the newest the composer is empty again.
  press('ArrowDown');
  expect(input().value).toBe('');
  // And past that, ArrowDown is the caret's own key once more.
  expect(press('ArrowDown')).toBe(true);

  // Typing leaves recall, so the next ArrowUp starts from the most recent.
  await type('something of my own');
  expect(press('ArrowUp')).toBe(true);
  expect(input().value).toBe('something of my own');
  await type('');
  press('ArrowUp');
  expect(input().value).toBe('the newer one');
});

test('Ctrl+S stashes the composer under the thread, and an empty one takes it back', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);

  await type('a prompt I am not ready to send');
  input().focus();
  expect(press('s', { ctrlKey: true })).toBe(false);

  expect(input().value).toBe('');
  expect(JSON.parse(window.localStorage.getItem(STASH_STORAGE_KEY) ?? 'null')).toEqual({
    't-trace': 'a prompt I am not ready to send'
  });

  // The empty composer takes it back, and the stash is spent.
  input().focus();
  press('s', { ctrlKey: true });
  expect(input().value).toBe('a prompt I am not ready to send');
  expect(input().selectionStart).toBe('a prompt I am not ready to send'.length);
  expect(window.localStorage.getItem(STASH_STORAGE_KEY)).toBeNull();

  // The browser's own save dialog stays shut wherever the focus is.
  input().blur();
  expect(press('s', { ctrlKey: true })).toBe(false);
});
