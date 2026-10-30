import { afterEach, expect, test } from 'vitest';
import type { ThreadSummary } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { canMarkDone, groupWorkingThread, markDone, RecentPreferences, RECENT_STORAGE_KEY } from './recent.svelte';

let client: FakeClient;
let store: Store;
afterEach(() => { store?.detach(); client?.close(); localStorage.clear(); });

test('working grouping retains attention for pins, drafts, questions and failures, including idle background work', async () => {
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  const base = { ...store.threads.find(thread => thread.id === 't-trace')!, pinned: false, unread: false, backgroundWork: null };
  const working = { ...base, status: 'running' as const };
  expect(groupWorkingThread(store, working)).toBe(true);
  expect(groupWorkingThread(store, { ...base, status: 'queued' })).toBe(true);
  expect(groupWorkingThread(store, { ...base, status: 'idle', backgroundWork: { kinds: ['monitor'], since: 1 } })).toBe(true);
  expect(groupWorkingThread(store, { ...working, pinned: true })).toBe(false);
  for (const status of ['waiting', 'error', 'idle'] as ThreadSummary['status'][]) expect(groupWorkingThread(store, { ...base, status })).toBe(false);
  store.composerStates[base.id] = { text: 'Follow up', attachments: [], queued: [], sending: false, paused: false };
  expect(groupWorkingThread(store, working)).toBe(false);
});

test('Mark done accepts a draft synchronized from another device', async () => {
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  const peer = client.composerPeer({ delayMs: 0 });
  try {
    await peer.connect();
    await peer.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0,
      value: { input: { text: 'Draft from my phone', attachments: [], queued: [], paused: true } } });
    await expect.poll(() => store.composerStates[thread.id]?.text).toBe('Draft from my phone');
    expect(canMarkDone(store, thread)).toBe(true);
    expect(await markDone(store, thread)).toBe(true);
    expect((await client.call('threads.get', { threadId: thread.id })).archived).toBe(true);
    expect(store.error).toBeNull();
  } finally { peer.close(); }
});

test('grouping preferences retain each other, migrate the working choice and ignore invalid storage', () => {
  const prefs = new RecentPreferences();
  expect(prefs.groupWorking).toBe(false);
  expect(prefs.groupOtherProjects).toBe(true);
  prefs.setGroupOtherProjects(false);
  prefs.setGroupWorking(true);
  expect(new RecentPreferences().groupWorking).toBe(true);
  expect(new RecentPreferences().groupOtherProjects).toBe(false);
  prefs.setGroupOtherProjects(true);
  expect(new RecentPreferences().groupWorking).toBe(true);
  prefs.setGroupWorking(false);
  expect(new RecentPreferences().groupWorking).toBe(false);
  localStorage.setItem(RECENT_STORAGE_KEY, '{"groupWorking":true}');
  expect(new RecentPreferences().groupOtherProjects).toBe(true);
  localStorage.setItem(RECENT_STORAGE_KEY, 'null');
  expect(new RecentPreferences().groupWorking).toBe(false);
});
