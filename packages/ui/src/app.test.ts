import { afterEach, expect, test } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
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

async function mountOnFake(): Promise<void> {
  window.history.replaceState(null, '', '/?fake=1');
  const target = document.createElement('div');
  document.body.appendChild(target);
  running = mount(App, { target });
  await waitFor(() => store.openThread !== null);
}

test('the app mounts against the fake core, lists the seeded threads and opens the latest', async () => {
  await mountOnFake();
  await waitFor(() => store.threads.length === 4);
  await waitFor(() => (document.body.textContent ?? '').includes('Finish the trace tab'));

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
  await mountOnFake();

  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  expect(document.querySelector('[data-testid=draft-row]')).not.toBeNull();
  expect(store.openThread).toBeNull();

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Rename the scheduler caps\nand nothing else';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.title).toBe('Rename the scheduler caps');
  expect(store.threads.length).toBe(5);
  await waitFor(() => store.openThread?.messages.length === 2);
  expect(store.openThread?.messages[0]?.role).toBe('user');
});

test('the picker lists providers with their accounts and the models of the one shown, legacy folded', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  // A draft opens on the first available provider, its default model.
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  const instances = Array.from(document.querySelectorAll('[data-instance]')).map((el) => el.getAttribute('data-instance'));
  expect(instances).toEqual(['claude::a-claude-main', 'claude::a-claude-side', 'echo::a-echo']);
  const models = Array.from(document.querySelectorAll('[data-model]')).map((el) => el.getAttribute('data-model'));
  expect(models).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']);

  query<HTMLButtonElement>('[data-testid=picker-legacy]').click();
  await waitFor(() => document.querySelectorAll('[data-model]').length === 7);

  // The second account of the same provider, then a model: one thread with both.
  query<HTMLButtonElement>('[data-instance="claude::a-claude-side"]').click();
  query<HTMLButtonElement>('[data-model="claude-opus-5"]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('Claude Opus 5 · Second seat');

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the second seat';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.accountId).toBe('a-claude-side');
  expect(store.openThread?.model).toBe('claude-opus-5');
});

test('the Reasoning row sets the effort of the picked model, and the default level clears the suffix', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-effort]') !== null);
  const levels = Array.from(document.querySelectorAll('[data-effort]')).map((el) => el.getAttribute('data-effort'));
  expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink']);
  // Nothing chosen yet, so the model's own default reads as the active one.
  expect(query('[data-effort=high]').getAttribute('aria-pressed')).toBe('true');

  query<HTMLButtonElement>('[data-effort=xhigh]').click();
  await waitFor(() => query('[data-effort=xhigh]').getAttribute('aria-pressed') === 'true');
  // Picking a level keeps the popover open: it is a setting of the model, not a choice of its own.
  expect(document.querySelector('[data-testid=composer-picker-menu]')).not.toBeNull();
  expect(query('[data-testid=composer-picker]').textContent).toContain('Claude Sonnet 5 · Extra high');

  query<HTMLButtonElement>('[data-effort=high]').click();
  await waitFor(() => query('[data-effort=high]').getAttribute('aria-pressed') === 'true');
  expect(query('[data-testid=composer-picker]').textContent).not.toContain('Extra high');

  // The draft carries the effort into the thread the first send creates.
  query<HTMLButtonElement>('[data-effort=xhigh]').click();
  await waitFor(() => query('[data-effort=xhigh]').getAttribute('aria-pressed') === 'true');
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Think harder about the caps';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.effort).toBe('xhigh');
});

test('a right click on a thread row opens the context menu, and Archive removes the row', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length === 4);

  const row = query<HTMLButtonElement>('[data-thread-id="t-bench"]');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  const labels = Array.from(document.querySelectorAll('[data-testid=context-menu] [data-row]')).map((el) => el.textContent?.trim());
  expect(labels).toEqual(['Open', 'Rename', 'Archive']);

  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archive]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length === 3);
  expect(document.querySelector('[data-thread-id="t-bench"]')).toBeNull();
});

test('removing a project asks first, and Cancel keeps it', async () => {
  await mountOnFake();
  const head = query('[data-project-id="p-brain"][data-testid=project-row]');
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=remove]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  expect(document.querySelector('[data-testid=confirm-dialog]')?.textContent).toContain('brain');

  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(store.projects.length).toBe(2);
});
