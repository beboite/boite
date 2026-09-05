import { afterEach, expect, test } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

test('the app mounts against the fake core, lists the seeded threads and opens the latest', async () => {
  window.history.replaceState(null, '', '/?fake=1');
  const target = document.createElement('div');
  document.body.appendChild(target);

  running = mount(App, { target });

  await waitFor(() => store.threads.length === 4);
  await waitFor(() => (document.body.textContent ?? '').includes('Finish the trace tab'));
  await waitFor(() => store.openThread !== null);

  const text = document.body.textContent ?? '';
  expect(text).toContain('boite');
  expect(text).toContain('Port the scheduler');
  expect(text).toContain('Connected');
  expect(document.querySelector('[data-testid=composer-input]')).not.toBeNull();
  expect(document.querySelectorAll('[data-testid=thread-row]').length).toBe(4);
  // The most recent thread opens on its own; nothing to click first.
  expect(store.openThread?.id).toBe('t-descriptors');
});

test('New thread opens a draft and the first send creates the thread titled from the prompt', async () => {
  window.history.replaceState(null, '', '/?fake=1');
  const target = document.createElement('div');
  document.body.appendChild(target);
  running = mount(App, { target });
  await waitFor(() => store.openThread !== null);

  (document.querySelector('[data-testid=new-thread]') as HTMLButtonElement).click();
  await waitFor(() => store.draft !== null);
  expect(document.querySelector('[data-testid=draft-row]')).not.toBeNull();
  expect(store.openThread).toBeNull();

  const input = document.querySelector('[data-testid=composer-input]') as HTMLTextAreaElement;
  input.value = 'Rename the scheduler caps\nand nothing else';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !(document.querySelector('[data-testid=composer-send]') as HTMLButtonElement).disabled);
  (document.querySelector('[data-testid=composer-send]') as HTMLButtonElement).click();

  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.title).toBe('Rename the scheduler caps');
  expect(store.threads.length).toBe(5);
  await waitFor(() => store.openThread?.messages.length === 2);
  expect(store.openThread?.messages[0]?.role).toBe('user');
});
