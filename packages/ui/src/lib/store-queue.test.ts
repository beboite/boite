import { expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

async function ready() {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  return { store, client };
}

const queued = (text: string, paused = false) => ({
  text: '', attachments: [], queued: [{ text, attachments: [] }], sending: false, paused
});

test('queues belong to their Store even when another machine has the same thread id', async () => {
  const first = await ready();
  const second = await ready();
  const firstCalls = vi.spyOn(first.client, 'call');
  const secondCalls = vi.spyOn(second.client, 'call');
  try {
    first.store.composerStates['t-trace'] = queued('First machine');
    second.store.composerStates['t-trace'] = queued('Second machine');
    await vi.waitFor(() => {
      expect(first.store.composerStates['t-trace']?.queued).toHaveLength(0);
      expect(second.store.composerStates['t-trace']?.queued).toHaveLength(0);
      expect(first.store.composerStates['t-trace']?.sending).toBe(false);
      expect(second.store.composerStates['t-trace']?.sending).toBe(false);
    });
    expect(firstCalls.mock.calls.filter(([method]) => method === 'turns.start')).toEqual([
      ['turns.start', expect.objectContaining({ threadId: 't-trace', prompt: 'First machine' })]
    ]);
    expect(secondCalls.mock.calls.filter(([method]) => method === 'turns.start')).toEqual([
      ['turns.start', expect.objectContaining({ threadId: 't-trace', prompt: 'Second machine' })]
    ]);
    expect(first.store.openThread).toBeNull();
    expect(second.store.openThread).toBeNull();
  } finally {
    first.store.detach(); first.client.close();
    second.store.detach(); second.client.close();
  }
});

test('paused, archived and detached queues never send automatically', async () => {
  const { store, client } = await ready();
  const calls = vi.spyOn(client, 'call');
  try {
    store.composerStates['t-trace'] = queued('Restored queue', true);
    store.threads.find(row => row.id === 't-descriptors')!.archived = true;
    store.composerStates['t-descriptors'] = queued('Archived queue');
    flushSync();
    expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
    store.detach();
    store.composerStates['t-trace']!.paused = false;
    store.threads.find(row => row.id === 't-descriptors')!.archived = false;
    flushSync();
    expect(store.composerStates['t-trace']!.queued).toHaveLength(1);
    expect(store.composerStates['t-descriptors']!.queued).toHaveLength(1);
    expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
  } finally { store.detach(); client.close(); }
});
