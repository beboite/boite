import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
let app: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (app) await unmount(app, { outro: false });
  app = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
});
async function waitFor(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 4000, interval: 5 });
}
function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
  button!.click();
}
function reset() {
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.composerStates = {};
}
test('the existing thread picker switches providers and back without losing the conversation or draft', async () => {
  history.replaceState(null, '', '/?fake=1');
  reset();
  app = mount(App, { target: document.body });
  await waitFor(() => store.booted && store.openThread !== null);
  const original = { ...store.openThread! };
  const id = original.id;
  const messages = original.messages.map((message) => message.id);
  const count = store.threads.length;
  const input = document.querySelector<HTMLTextAreaElement>('[data-testid=composer-input]')!;
  input.value = 'Keep my unfinished prompt';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  click('[data-testid=composer-picker]');
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  click('[data-testid=composer-picker-menu] [data-provider="claude"]');
  await waitFor(() => document.querySelector('[data-model="claude-fable-5-1"]') !== null);
  click('[data-model="claude-fable-5-1"]');
  await waitFor(() => store.openThread?.providerId === 'claude');
  expect(store.openThread?.id).toBe(id);
  expect(store.openThread?.model).toBe('claude-fable-5-1');
  expect(store.openThread?.messages.map((message) => message.id)).toEqual(messages);
  expect(input.value).toBe('Keep my unfinished prompt');
  expect(store.threads).toHaveLength(count);
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  click('[data-testid=composer-picker]');
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  click(`[data-testid=composer-picker-menu] [data-provider="${original.providerId}"]`);
  await waitFor(() => document.querySelector(`[data-model="${original.model}"]`) !== null);
  click(`[data-model="${original.model}"]`);
  await waitFor(() => store.openThread?.sessionGeneration === 2);
  expect(store.openThread?.id).toBe(id);
  expect(store.openThread?.messages.map((message) => message.id)).toEqual(messages);
});
