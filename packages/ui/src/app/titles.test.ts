import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { mountOnFake, press, query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('Regenerate title in the thread menu waits on the agent, then the row and the header carry its words', async () => {
  store.draft = null;
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  const before = store.threads.find((thread) => thread.id === 't-trace')?.title;
  expect(before).toBe('Finish the trace tab');

  const row = query<HTMLButtonElement>('[data-thread-id="t-trace"]');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=retitle]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);

  // While the fake writes, the menu says so and takes the item away.
  expect(store.retitling).toEqual(['t-trace']);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  const waiting = query<HTMLButtonElement>('[data-testid=context-menu] [data-value=retitle]');
  expect(waiting.textContent?.trim()).toBe('Writing a title');
  expect(waiting.disabled).toBe(true);
  press('Escape');

  await waitFor(() => store.retitling.length === 0);
  const after = store.threads.find((thread) => thread.id === 't-trace');
  expect(after).toMatchObject({ title: 'Echo: What does the trace tab', titleSource: 'agent' });
  await waitFor(() => query('[data-thread-id="t-trace"]').textContent?.includes('Echo: What does the trace tab') === true);

  // The open thread is the same one: its header follows.
  await store.open('t-trace');
  await waitFor(() => query('[data-testid=thread-title]').textContent?.trim() === 'Echo: What does the trace tab');
});

test('the chat header keeps the title alone, and the rows say what each agent is doing', async () => {
  // The store is the singleton every test shares: a draft left open by another
  // one would keep the boot from opening a thread at all.
  store.draft = null;
  await mountOnFake();

  // The status is the row's to say: the header repeats neither a word nor a dot.
  expect(document.querySelector('[data-testid=thread-status-label]')).toBeNull();
  expect(document.querySelector('[data-testid=thread-header] .mark')).toBeNull();
  expect(query('[data-testid=thread-header]').getAttribute('data-status')).toBe('idle');
  expect(query('[data-testid=thread-title]').textContent?.trim()).toBe(store.openThread?.title);

  // No dot on any row; a thread waiting on the user says so in words.
  expect(document.querySelector('[data-testid=thread-row] .mark')).toBeNull();
  const waiting = query('[data-testid=thread-row][data-thread-id=t-scheduler] [data-testid=thread-state]');
  expect(waiting.dataset['state']).toBe('waiting');
  expect(waiting.textContent?.trim()).toBe('Needs you');
});
