import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import ThreadHeader from './ThreadHeader.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let client: FakeClient;
let store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  store?.detach(); client?.close();
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
});

async function renameOpen(text: string): Promise<HTMLInputElement> {
  document.querySelector<HTMLButtonElement>('[data-testid=thread-title]')!.click();
  flushSync();
  const input = document.querySelector<HTMLInputElement>('[data-testid=thread-rename-input]')!;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return input;
}

async function start(): Promise<ReturnType<typeof vi.spyOn>> {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  await store.open('t-trace');
  mounted = mount(ThreadHeader, { target: document.body, props: { store } });
  await settle();
  return vi.spyOn(store, 'rename').mockResolvedValue();
}

test('a rename begun on one thread writes to that thread after another surface opens a different one', async () => {
  const rename = await start();
  const input = await renameOpen('Title for the trace thread');
  const other = store.threads.find(thread => thread.id !== 't-trace' && !thread.archived)!;
  await store.open(other.id);
  await settle();
  expect(store.openThread?.id).toBe(other.id);
  input.dispatchEvent(new FocusEvent('blur'));
  await settle();
  expect(rename.mock.calls).toEqual([['t-trace', 'Title for the trace thread']]);
  expect(document.querySelector('[data-testid=thread-rename-input]')).toBeNull();
});

test('Enter commits once and Escape commits nothing, whatever blur follows', async () => {
  const rename = await start();
  let input = await renameOpen('Kept');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.dispatchEvent(new FocusEvent('blur'));
  await settle();
  expect(rename.mock.calls).toEqual([['t-trace', 'Kept']]);

  input = await renameOpen('Dropped');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  input.dispatchEvent(new FocusEvent('blur'));
  await settle();
  expect(rename).toHaveBeenCalledTimes(1);
});
