import { afterEach, expect, test } from 'vitest';
import type { ProcessRecord } from '@boite/contracts';
import { FakeClient } from '../fake-client';
import { Store } from '../store.svelte';

let client: FakeClient;
let store: Store;
afterEach(() => { store?.detach(); client?.close(); localStorage.clear(); });

test('a thread opened while the machine is away does not show the trace of the thread before it', async () => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  await store.open('t-trace');
  store.trace = [{ pid: 41, name: 'node' } as unknown as ProcessRecord];
  const other = store.threads.find(thread => thread.id !== 't-trace' && !thread.archived)!;
  store.connection = 'closed';
  await store.open(other.id);
  expect(store.openThread?.id).toBe(other.id);
  expect(store.trace).toEqual([]);
});
