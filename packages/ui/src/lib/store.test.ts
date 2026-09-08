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
    expect(store.core?.version).toBe('2.0.0-beta.1');
    expect(store.projects.map((p) => p.id)).toEqual(['p-boite', 'p-brain']);
    expect(store.threads).toHaveLength(4);
    // Two seeded threads wait: one on a permission, one on a question.
    expect(store.threads.map((t) => t.status).sort()).toEqual([
      'idle',
      'idle',
      'waiting',
      'waiting'
    ]);
    expect(store.pendingPermissions.map((p) => p.id)).toEqual(['req-seed-1']);
    expect(store.pendingQuestions.map((q) => q.id)).toEqual(['qst-seed-1']);
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
    // The fake reasons before it answers, like a provider that streams thinking.
    expect(assistant?.parts).toEqual([
      { type: 'thinking', text: 'thinking about: read the trace note' },
      { type: 'text', text: 'read the trace note' }
    ]);
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

    // The seeded core already waits on one elsewhere, so pick this thread's.
    const pending = await waitFor(() => store.pendingPermissions.find((p) => p.threadId === 't-trace'));
    expect(pending.toolName).toBe('Write');

    await store.answer(pending.id, 'allow');
    await client.settled();

    const parts = store.openThread?.messages.at(-1)?.parts ?? [];
    expect(parts.map((p) => p.type)).toEqual(['thinking', 'text', 'permission', 'tool']);
    const permission = parts[2];
    expect(permission?.type === 'permission' && permission.decision).toBe('allow');
    const tool = parts[3];
    expect(tool?.type === 'tool' && tool.status).toBe('done');
  });

  test('a project removed elsewhere drops it, its threads and the open thread', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');
    expect(store.openThread?.projectId).toBe('p-boite');

    // Straight through the client, the way another connection's removal arrives.
    await client.call('projects.remove', { projectId: 'p-boite' });

    expect(store.projects.map((p) => p.id)).toEqual(['p-brain']);
    expect(store.threads.every((t) => t.projectId !== 'p-boite')).toBe(true);
    const reopened = await waitFor(() => store.openThread ?? undefined);
    expect(reopened.projectId).toBe('p-brain');
  });

  test('a probe elsewhere fills the models of that instance, the descriptor until then', async () => {
    const { store, client } = await ready();
    expect(store.modelsOf('opencode', 'a-opencode').map((m) => m.id)).toEqual(['default']);
    expect(store.probedModels).toEqual({});

    // Straight through the client: what a second shell's probe looks like here.
    await client.call('providers.probe', { providerId: 'opencode', accountId: 'a-opencode' });

    expect(Object.keys(store.probedModels)).toEqual(['opencode::a-opencode']);
    const probed = store.modelsOf('opencode', 'a-opencode').map((m) => m.id);
    expect(probed.length).toBe(23);
    expect(probed.slice(0, 3)).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5-codex']);
    // A provider that is not ACP keeps the descriptor's list either way.
    expect(store.modelsOf('echo', 'a-echo').map((m) => m.id)).toEqual(['echo-1']);
  });

  test('settings changed elsewhere replace the ones the UI holds', async () => {
    const { store, client } = await ready();
    expect(store.settings?.maxConcurrentTurns).not.toBe(9);

    await client.call('settings.set', { maxConcurrentTurns: 9 });

    expect(store.settings?.maxConcurrentTurns).toBe(9);
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
