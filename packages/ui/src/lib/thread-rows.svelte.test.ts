import { expect, test } from 'vitest';
import { flushSync } from 'svelte';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { unlistedPanels } from './thread-rows';
import { moveBlocked } from './thread-move.svelte';

async function ready(): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  return { store, client };
}

test('a load tick patches its row and leaves the project lists alone', async () => {
  const { store, client } = await ready();
  try {
    const row = store.threadsOf('p-boite')[0]!;
    let lists = 0;
    let unread = 0;
    let loads = 0;
    const stop = $effect.root(() => {
      $effect(() => { store.threadsOf('p-boite'); lists++; });
      $effect(() => { void store.unreadCount; unread++; });
      $effect(() => { void row.load; loads++; });
    });
    flushSync();
    expect([lists, unread, loads]).toEqual([1, 1, 1]);

    for (let tick = 0; tick < 20; tick++) {
      client.sampleLoad(row.id, tick + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
    }
    // The row the sidebar holds is the one that moved, not a copy of it.
    expect(store.threadsOf('p-boite')[0]).toBe(row);
    expect(row.load?.processes).toBe(20);
    expect(loads).toBeGreaterThan(1);
    expect([lists, unread]).toEqual([1, 1]);

    // A change the lists do read still reaches them.
    await store.pin(row.id, !row.pinned);
    flushSync();
    await store.archive(row.id);
    flushSync();
    expect(lists).toBeGreaterThan(1);
    expect(store.threadsOf('p-boite').some((thread) => thread.id === row.id)).toBe(false);
    stop();
  } finally {
    store.detach();
    client.close();
  }
});

test('the project lists hold the live top-level threads of each project', async () => {
  const { store, client } = await ready();
  try {
    const all = store.threads.filter((thread) => !thread.archived && !thread.parentThreadId);
    const grouped = store.projects.flatMap((project) => store.threadsOf(project.id));
    expect(grouped.map((thread) => thread.id).sort()).toEqual(all.filter((thread) => thread.projectId !== null).map((thread) => thread.id).sort());
    expect(store.threadsOf('p-missing')).toEqual([]);
  } finally {
    store.detach();
    client.close();
  }
});

test('mounted parent rows share move eligibility work and track child lifecycle within their machine', async () => {
  const { store, client } = await ready();
  const { store: other, client: otherClient } = await ready();
  let stop = () => {};
  try {
    let visits = 0;
    const sample = store.threads[0]!;
    const parents = Array.from({ length: 200 }, (_, index) => ({
      ...sample, id: `parent-${index}`, get parentThreadId() { visits++; return null; },
    }));
    store.threads = parents;
    const blocked = new Map<string, boolean>();
    stop = $effect.root(() => {
      for (const parent of store.threads) $effect(() => { blocked.set(parent.id, moveBlocked(store, parent.id)); });
    });
    flushSync();
    expect([...blocked.values()].every(value => value === false)).toBe(true);
    expect(visits).toBeLessThanOrEqual(parents.length * 2);
    const child = { ...sample, id: 'child', parentThreadId: parents[0]!.id, archived: false, status: 'running' as const };
    store.threads.push(child);
    flushSync();
    expect(blocked.get(child.parentThreadId)).toBe(true);
    expect(moveBlocked(other, child.parentThreadId)).toBe(false);
    for (const status of ['idle', 'queued', 'waiting', 'error'] as const) {
      store.threads.at(-1)!.status = status;
      flushSync();
      expect(blocked.get(child.parentThreadId)).toBe(status === 'queued' || status === 'waiting');
    }
    store.threads.at(-1)!.status = 'running';
    store.threads.at(-1)!.archived = true;
    flushSync();
    expect(blocked.get(child.parentThreadId)).toBe(false);
    store.threads.at(-1)!.archived = false;
    flushSync();
    expect(blocked.get(child.parentThreadId)).toBe(true);
    store.threads.pop();
    flushSync();
    expect(blocked.get(child.parentThreadId)).toBe(false);
  } finally {
    stop(); store.detach(); client.close(); other.detach(); otherClient.close();
  }
});

test('a list prunes only its own machine layouts, never the thread on screen', () => {
  const key = (machine: string, id: string) => JSON.stringify([machine, id]);
  const stale = unlistedPanels('http://a.test', new Set([key('http://a.test', 't-live')]), key('http://a.test', 't-open'));
  expect(stale(key('http://a.test', 't-gone'))).toBe(true);
  expect(stale(key('http://a.test', 't-live'))).toBe(false);
  expect(stale(key('http://a.test', 't-open'))).toBe(false);
  expect(stale(key('http://b.test', 't-gone'))).toBe(false);
  expect(stale('not json')).toBe(false);
  // A store with no machine id writes bare keys and owns only those.
  const bare = unlistedPanels('', new Set(['t-live']), null);
  expect(bare('t-gone')).toBe(true);
  expect(bare(key('http://a.test', 't-gone'))).toBe(false);
});
