import { expect, test, vi } from 'vitest';
import type { RpcEventName, RpcEvents, ThreadSummary } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

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
  return { store, emit, close() { store.detach(); client.close(); } };
}

const load = (processes: number): RpcEvents['thread.load']['load'] => ({ processes, cpuPercent: processes, memoryBytes: 1_000_000 * processes });

test('load samples find their row through the id index, after the list is replaced or grows', async () => {
  const fixture = await connected();
  try {
    const { store, emit } = fixture;
    const first = store.threads[0]!;
    // A sample is a lookup, not a scan of every row through the proxy.
    const find = vi.spyOn(Array.prototype, 'find');
    for (let sample = 1; sample <= 200; sample++) emit('thread.load', { threadId: first.id, load: load(sample) });
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
