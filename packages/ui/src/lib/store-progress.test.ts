import { expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

test('an owning Store follows current progress, reconnect snapshots, and completion', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  const observed: string[] = [];
  client.on('thread.updated', thread => {
    if (thread.id === 't-trace' && thread.progress) observed.push(thread.progress.phase);
  });
  try {
    await store.connect();
    await store.open('t-trace');
    await store.send('[permission] Keep working');
    await vi.waitFor(() => expect(store.pendingPermissions.some(permission => permission.threadId === 't-trace')).toBe(true));
    const permission = store.pendingPermissions.find(permission => permission.threadId === 't-trace')!;
    await vi.waitFor(() => expect(observed).toContain('thinking'));
    const current = await client.call('threads.get', { threadId: 't-trace' });
    expect(current.progress?.turnId).toBe(current.turns.at(-1)?.id);
    expect(store.openThread?.progress?.turnId).toBe(current.progress?.turnId);
    await store.open('t-trace', false);
    expect(store.openThread?.progress).toMatchObject({ turnId: current.progress!.turnId, at: expect.any(Number) });
    await client.call('permissions.answer', { requestId: permission.id, decision: 'allow' });
    await client.settled();
    expect(observed).toContain('working');
    expect(store.openThread?.progress).toBeNull();
    expect((await client.call('threads.get', { threadId: 't-trace' })).progress).toBeNull();
  } finally { store.detach(); client.close(); }
});
