import { beforeEach, describe, expect, test } from 'vitest';
import type { ThreadStatus } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

async function ready(): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  return { store, client };
}

describe('Store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('opens on the seeded core', async () => {
    const { store } = await ready();

    expect(store.connection).toBe('ready');
    expect(store.core?.version).toBe('2.0.0-alpha.1');
    expect(store.projects.map((p) => p.id)).toEqual(['p-boite', 'p-brain']);
    expect(store.threads).toHaveLength(4);
    expect(store.threads.map((t) => t.status).sort()).toEqual([
      'idle',
      'idle',
      'queued',
      'running'
    ]);
    expect(store.unreadCount).toBe(1);
  });

  test('opening a thread clears its unread badge', async () => {
    const { store } = await ready();

    await store.open('t-descriptors');

    expect(store.openThread?.id).toBe('t-descriptors');
    expect(store.openThread?.unread).toBe(false);
    expect(store.threads.find((t) => t.id === 't-descriptors')?.unread).toBe(false);
    expect(store.unreadCount).toBe(0);
  });

  test('a prompt streams into one text part and the thread goes running then idle', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    const seen: ThreadStatus[] = [];
    client.on('thread.updated', (summary) => {
      if (summary.id === 't-trace') seen.push(summary.status);
    });

    const before = store.openThread?.messages.length ?? 0;
    await store.send('read the trace note');
    await client.settled();

    expect(seen).toContain('running');
    expect(seen.at(-1)).toBe('idle');
    expect(store.openThread?.status).toBe('idle');

    const messages = store.openThread?.messages ?? [];
    expect(messages).toHaveLength(before + 2);

    const assistant = messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.state).toBe('complete');
    expect(assistant?.parts).toEqual([{ type: 'text', text: 'read the trace note' }]);
  });

  test('only the open thread streams, and the previous one is dropped', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');
    await store.open('t-descriptors');

    const deltas: string[] = [];
    client.on('message.delta', (delta) => deltas.push(delta.threadId));

    await client.call('turns.start', { threadId: 't-trace', prompt: 'nobody is watching' });
    await client.settled();

    expect(deltas).toEqual([]);
    expect(store.threads.find((t) => t.id === 't-trace')?.unread).toBe(true);
  });

  test('a tool part and a permission part land in the open thread', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    void store.send('[tool] and [permission] please');
    await Promise.resolve();

    const pending = await waitFor(() => store.pendingPermissions[0]);
    expect(pending.toolName).toBe('Write');

    await store.answer(pending.id, 'allow');
    await client.settled();

    const parts = store.openThread?.messages.at(-1)?.parts ?? [];
    expect(parts.map((p) => p.type)).toEqual(['text', 'permission', 'tool']);
    const permission = parts[1];
    expect(permission?.type === 'permission' && permission.decision).toBe('allow');
    const tool = parts[2];
    expect(tool?.type === 'tool' && tool.status).toBe('done');
  });
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition never became true');
}
