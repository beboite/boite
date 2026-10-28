import { afterEach, expect, test, vi } from 'vitest';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';
import type { FakeClientOptions } from './fake-client/context';

const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** A connected store, and the bytes of every thread list its client was answered. */
async function connected(options: FakeClientOptions = {}) {
  const client = new FakeClient({ delayMs: 0, ...options });
  const store = new Store();
  stores.push(store);
  store.attach(client);
  await store.connect();
  const real = client.call.bind(client);
  const lists: { method: string; bytes: number }[] = [];
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: never, callOptions?: never) => {
    const answer = real(method as never, params, callOptions);
    if (method !== 'threads.list' && method !== 'threads.listChanges') return answer;
    return answer.then((result) => { lists.push({ method, bytes: bytes(result) }); return result; });
  }) as typeof client.call);
  return { client, store, lists, real };
}

async function reconnect(client: FakeClient, store: Store, away: () => Promise<unknown> = async () => undefined) {
  client.drop();
  await away();
  await client.restore();
  await store.reload();
}

test('a reconnect after one thread changed among two thousand reads that thread, not the list', async () => {
  const { client, store, lists } = await connected({ idle: 2000 });
  const rows = new Map(store.threads.map(row => [row.id, row]));
  expect(rows.size).toBeGreaterThan(2000);
  const whole = bytes(await client.elsewhere('threads.list', {}));

  await reconnect(client, store, () => client.elsewhere('threads.pin', { threadId: 't-idle-7', pinned: true }));

  expect(store.threads.find(row => row.id === 't-idle-7')?.pinned).toBe(true);
  expect(store.threads).toHaveLength(rows.size);
  // The rows the gap left alone are the same objects, so nothing redraws.
  for (const row of store.threads) if (row.id !== 't-idle-7' && row.load == null) expect(row).toBe(rows.get(row.id));
  const read = lists.reduce((sum, list) => sum + list.bytes, 0);
  console.info(`thread list on reconnect: ${read} bytes, the whole list ${whole} bytes`);
  expect(lists.map(list => list.method)).toEqual(['threads.listChanges']);
  expect(whole).toBeGreaterThan(500_000);
  expect(read).toBeLessThan(whole / 50);
  expect(store.error).toBeNull();
});

test('a thread deleted and one archived while away leave the sidebar', async () => {
  const { client, store } = await connected();
  expect(store.threads.some(row => row.id === 't-trace')).toBe(true);
  expect(store.threads.some(row => row.id === 't-descriptors')).toBe(true);

  await reconnect(client, store, async () => {
    await client.elsewhere('threads.archive', { threadId: 't-trace' });
    await client.elsewhere('threads.remove', { threadId: 't-descriptors' });
  });

  expect(store.threads.map(row => row.id)).not.toContain('t-trace');
  expect(store.threads.map(row => row.id)).not.toContain('t-descriptors');
  expect(store.threads.length).toBeGreaterThan(0);
});

test('a thread created while away joins the sidebar', async () => {
  const { client, store } = await connected();
  let created = '';
  await reconnect(client, store, async () => {
    created = (await client.elsewhere('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', permissionMode: 'default' })).id;
  });
  expect(store.threads.map(row => row.id)).toContain(created);
});

test('a core without the change log is read whole, with no error', async () => {
  const { client, store, lists } = await connected({ missing: ['threads.listChanges'] });
  expect(client.core?.features?.listChanges).toBe(false);
  await reconnect(client, store, () => client.elsewhere('threads.pin', { threadId: 't-trace', pinned: true }));
  expect(lists.map(list => list.method)).toEqual(['threads.list']);
  expect(store.threads.find(row => row.id === 't-trace')?.pinned).toBe(true);
  expect(store.error).toBeNull();
});

test('a load the gap ended is cleared on a row the answer left out', async () => {
  const { client, store } = await connected();
  client.sampleLoad('t-trace', 2);
  await vi.waitFor(() => expect(store.threads.find(row => row.id === 't-trace')?.load?.processes).toBe(2));
  await reconnect(client, store, async () => client.endLoad('t-trace'));
  expect(store.threads.find(row => row.id === 't-trace')?.load ?? null).toBeNull();
});

test('a deletion the list left to a newer read that gave up is read again on the next reconnect', async () => {
  const { client, store, real } = await connected();
  let release: (() => void) | null = null;
  vi.mocked(client.call).mockImplementation(((method: string, params: never, callOptions?: never) => {
    const answer = real(method as never, params, callOptions);
    if (method !== 'threads.listChanges' || release) return answer;
    return answer.then(value => new Promise(resolve => { release = () => resolve(value); }));
  }) as typeof client.call);
  client.drop();
  await client.elsewhere('threads.remove', { threadId: 't-trace' });
  await client.restore();
  await vi.waitFor(() => expect(release).not.toBeNull());
  // A press on the row reads it after the list was asked: the list leaves that row to it.
  const giveUp = store.preload('t-trace');
  release!();
  await store.reload();
  giveUp();
  expect(store.threads.some(row => row.id === 't-trace')).toBe(true);

  await reconnect(client, store);
  expect(store.threads.some(row => row.id === 't-trace')).toBe(false);
});
