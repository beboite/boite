import { expect, test, vi } from 'vitest';
import type { RpcEventName, RpcEvents, ThreadSummary } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { restoreThread } from './archive';

async function connected() {
  const client = new FakeClient({ delayMs: 0 });
  const handlers = new Map<string, (payload: unknown) => void>();
  const on = client.on.bind(client);
  vi.spyOn(client, 'on').mockImplementation(((event: RpcEventName, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
    return on(event, handler);
  }) as typeof client.on);
  const store = new Store();
  store.attach(client);
  await store.connect();
  const emit = <E extends RpcEventName>(event: E, payload: RpcEvents[E]) => handlers.get(event)!(payload);
  return { store, client, emit, close() { store.detach(); client.close(); } };
}

const load = (processes: number): RpcEvents['thread.load']['load'] => ({ processes, cpuPercent: processes, memoryBytes: 1_000_000 * processes });

test.each(['thread.load', 'thread.updated'] as const)('%s finds its row through the id index, after the list is replaced or grows', async (event) => {
  const fixture = await connected();
  try {
    const { store, emit } = fixture;
    const first = store.threads[0]!;
    // A sample is a lookup, not a scan of every row through the proxy.
    const find = vi.spyOn(Array.prototype, 'find');
    for (let sample = 1; sample <= 200; sample++) {
      if (event === 'thread.load') emit(event, { threadId: first.id, load: load(sample) });
      else emit(event, { ...first, load: load(sample) });
    }
    expect(find.mock.calls.length).toBeLessThan(20);
    find.mockRestore();
    expect(store.threads.find(row => row.id === first.id)!.load?.processes).toBe(200);

    // A row created after the index was built, then a list that replaced the array.
    const added = { ...JSON.parse(JSON.stringify(first)), id: 't-index-added', title: 'Added' } as ThreadSummary;
    emit('thread.created', added);
    emit('thread.load', { threadId: 't-index-added', load: load(3) });
    expect(store.threads.find(row => row.id === 't-index-added')!.load?.processes).toBe(3);
    store.threads = store.threads.filter(row => row.id !== first.id);
    emit('thread.load', { threadId: first.id, load: load(9) });
    emit('thread.load', { threadId: 't-index-added', load: load(4) });
    expect(store.threads.some(row => row.id === first.id)).toBe(false);
    expect(store.threads.find(row => row.id === 't-index-added')!.load?.processes).toBe(4);
  } finally {
    fixture.close();
  }
});

test('a row written in place behind the index, as a restore does, still gets its updates and samples', async () => {
  const fixture = await connected();
  try {
    const { store, client, emit } = fixture;
    const first = store.threads[0]!;
    const clone = (id: string, title: string) => ({ ...JSON.parse(JSON.stringify(first)), id, title, archived: false }) as ThreadSummary;
    emit('thread.load', { threadId: first.id, load: load(1) });
    // The core announces the restored row, then the archive call answers with its own copy.
    emit('thread.updated', clone('t-restored', 'Restored'));
    const call = vi.spyOn(client, 'call').mockImplementation(async (_method, params) => clone((params as { threadId: string }).threadId, 'From the answer') as never);
    await restoreThread(store, 't-restored');
    emit('thread.updated', clone('t-restored', 'Renamed later'));
    emit('thread.load', { threadId: 't-restored', load: load(7) });
    const held = (id: string) => store.threads.find(row => row.id === id)!;
    expect(held('t-restored').title).toBe('Renamed later');
    expect(held('t-restored').load?.processes).toBe(7);
    expect(store.threads.filter(row => row.id === 't-restored')).toHaveLength(1);

    // A restore the event never announced appends the row behind the index.
    await restoreThread(store, 't-unannounced');
    call.mockRestore();
    emit('thread.load', { threadId: 't-unannounced', load: load(5) });
    expect(held('t-unannounced').load?.processes).toBe(5);
  } finally {
    fixture.close();
  }
});
