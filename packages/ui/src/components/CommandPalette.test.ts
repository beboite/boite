import { afterEach, beforeEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CommandPalette from './CommandPalette.svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';

let running: Record<string, unknown> | null = null;
let store: Store;
let client: FakeClient;

beforeEach(async () => {
  window.localStorage.clear();
  store = new Store();
  client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  await store.open('t-descriptors');
  running = mount(CommandPalette, { target: document.body, props: { store } });
  flushSync();
});

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function rows(): string[] {
  return Array.from(document.querySelectorAll('[data-testid=palette-row]')).map(
    (row) => row.getAttribute('data-palette-id') ?? ''
  );
}

function selectedId(): string | null {
  return document.querySelector('[data-testid=palette-row][aria-selected=true]')?.getAttribute('data-palette-id') ?? null;
}

async function type(text: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-testid=palette-input]');
  if (!input) throw new Error('no palette input');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  await tick();
}

function key(name: string): void {
  const input = document.querySelector<HTMLInputElement>('[data-testid=palette-input]');
  if (!input) throw new Error('no palette input');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  flushSync();
}

test('closed until asked, then the recents come first and the commands after them', async () => {
  expect(document.querySelector('[data-testid=palette]')).toBeNull();

  store.paletteOpen = true;
  flushSync();
  await tick();

  expect(document.querySelector('[data-testid=palette]')).not.toBeNull();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('palette-input');
  const ids = rows();
  // Every seeded thread first, then the commands; nothing typed.
  expect([...ids.slice(0, 4)].sort()).toEqual(['thread:t-bench', 'thread:t-descriptors', 'thread:t-scheduler', 'thread:t-trace']);
  expect(ids).toContain('new-thread');
  expect(ids).toContain('settings');
  expect(ids.at(-1)).toBe('archive');
  expect(selectedId()).toBe(ids[0]);
  expect(document.body.textContent).toContain('Threads');
  expect(document.body.textContent).toContain('Commands');
});

test('typing filters across threads and commands, the arrows move, Enter opens the thread', async () => {
  store.paletteOpen = true;
  flushSync();
  await tick();

  await type('sched');
  expect(rows()).toEqual(['thread:t-scheduler']);

  // A word the thread and a command share: both rows, the command's word
  // start earlier in its label so it ranks first.
  await type('trace');
  expect(rows()).toEqual(['trace', 'thread:t-trace']);
  expect(selectedId()).toBe('trace');
  key('ArrowDown');
  expect(selectedId()).toBe('thread:t-trace');
  key('ArrowDown');
  expect(selectedId()).toBe('trace');
  key('End');
  expect(selectedId()).toBe('thread:t-trace');
  key('Enter');

  await tick();
  expect(store.paletteOpen).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(store.openThread?.id).toBe('t-trace');
});

test('a command runs: settings opens on the tab asked, and Escape closes without picking', async () => {
  store.paletteOpen = true;
  flushSync();
  await tick();

  await type('providers');
  expect(rows()).toEqual(['providers']);
  key('Enter');
  expect(store.page).toBe('settings');
  expect(store.settingsTab).toBe('accounts');
  expect(store.paletteOpen).toBe(false);

  store.paletteOpen = true;
  flushSync();
  await tick();
  await type('zzzz');
  expect(rows()).toEqual([]);
  expect(document.body.textContent).toContain('Nothing matches.');
  key('Escape');
  expect(store.paletteOpen).toBe(false);
});

test('pin and unpin follow the open thread', async () => {
  store.paletteOpen = true;
  flushSync();
  await tick();
  await type('pin this');
  expect(rows()).toEqual(['pin']);
  expect(document.body.textContent).toContain('Pin this thread');
  key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(store.openThread?.pinned).toBe(true);

  store.paletteOpen = true;
  flushSync();
  await tick();
  await type('pin this');
  expect(document.body.textContent).toContain('Unpin this thread');
});

test('a load tick leaves the row the keyboard is on where it is', async () => {
  store.paletteOpen = true;
  flushSync();
  await tick();

  key('ArrowDown');
  key('ArrowDown');
  const picked = selectedId();
  expect(picked).toBe(rows()[2]);

  // The core pushes one of these a second for every thread with a live agent.
  client.sampleLoad('t-trace');
  client.sampleLoad('t-bench');
  flushSync();

  expect(rows()[2]).toBe(picked);
  expect(selectedId()).toBe(picked);

  // Typing still starts the walk over: that reset belongs to the query.
  await type('thread');
  expect(selectedId()).toBe(rows()[0]);
});

test('Escape on a row closes, Tab stays in the search field, and closing gives the focus back', async () => {
  const before = document.createElement('button');
  document.body.append(before);
  before.focus();
  store.paletteOpen = true;
  flushSync();
  await tick();

  const input = document.querySelector<HTMLInputElement>('[data-testid=palette-input]')!;
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  flushSync();
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);

  // A row the pointer focused still answers Escape.
  const row = document.querySelector<HTMLElement>('[data-testid=palette-row]')!;
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  flushSync();
  await tick();
  expect(store.paletteOpen).toBe(false);
  expect(document.activeElement).toBe(before);
});
