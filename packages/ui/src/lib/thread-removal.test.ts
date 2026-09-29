import { afterEach, expect, test } from 'vitest';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';
import { archiveThread, reopenLastArchived } from './archive';
import { undo } from './undo.svelte';

const stores: Store[] = [];
afterEach(() => {
  undo.dismiss();
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
});
async function ready() {
  const store = new Store();
  stores.push(store);
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  return store;
}

test('deleting a just-archived thread removes its undo offer and reopening skips it', async () => {
  const store = await ready();
  expect(await archiveThread(store, 't-trace')).toBe(true);
  expect(undo.current).not.toBeNull();
  expect(await store.removeThread('t-trace')).toBe(true);
  expect(undo.current).toBeNull();
  expect(await reopenLastArchived(store)).toBe(true);
  expect(store.openThread?.id).toBe('t-parser');
  expect(store.error).toBeNull();
});

test('deletion clears the owning machine composer and leaves colliding IDs on another machine intact', async () => {
  const first = await ready();
  const second = await ready();
  first.editComposerText('t-trace', 'First machine');
  second.editComposerText('t-trace', 'Second machine');
  await second.open('t-trace');
  expect(await first.removeThread('t-trace')).toBe(true);
  expect(first.threads.some(t => t.id === 't-trace')).toBe(false);
  expect(first.composerStates['t-trace']).toBeUndefined();
  expect(second.threads.some(t => t.id === 't-trace')).toBe(true);
  expect(second.openThread?.id).toBe('t-trace');
  expect(second.composerStates['t-trace']?.text).toBe('Second machine');
});
