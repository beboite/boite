import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from './workspace.svelte';
import { Store, store as primary } from './store.svelte';
import { FakeClient } from './fake-client';

let workspace: Workspace | undefined;
afterEach(() => {
  workspace?.close();
  localStorage.clear();
});
async function setup() {
  workspace = new Workspace();
  const a = primary,
    b = new Store();
  a.openThread = null;
  a.draft = null;
  a.visible = true;
  const ca = new FakeClient({ delayMs: 0 }),
    cb = new FakeClient({ delayMs: 0 });
  a.attach(ca);
  b.attach(cb);
  b.machineId = 'remote';
  b.visible = false;
  await Promise.all([a.connect(), b.connect()]);
  workspace.machines = [
    { id: 'local', label: 'Local', store: a },
    { id: 'remote', label: 'Remote', store: b }
  ];
  workspace.active = a;
  return { w: workspace, a, b, ca, cb };
}

test('identical ids on two hosts route rename, pin, permission and notifications to their owner', async () => {
  const { w, a, b } = await setup();
  const id = a.threads[0]!.id;
  expect(b.threads.some((t) => t.id === id)).toBe(true);
  await w.select(b, id);
  await b.rename(id, 'Remote only');
  await b.pin(id, true);
  expect(b.openThread?.title).toBe('Remote only');
  expect(a.threads.find((t) => t.id === id)?.title).not.toBe('Remote only');
  expect(a.threads.find((t) => t.id === id)?.pinned).toBe(false);
  const permission = b.pendingPermissions[0]!;
  expect(a.pendingPermissions.some((p) => p.id === permission.id)).toBe(true);
  await b.answer(permission.id, 'allow');
  expect(b.pendingPermissions.some((p) => p.id === permission.id)).toBe(false);
  expect(a.pendingPermissions.some((p) => p.id === permission.id)).toBe(true);
  await w.select(a, id);
  await w.openNotification(b.threadKey(id));
  expect(w.active).toBe(b);
  expect(w.active.openThread?.title).toBe('Remote only');
  expect(a.threadKey(id)).not.toBe(b.threadKey(id));
});

test('only the visible host keeps a thread subscription, and switching back resumes it', async () => {
  const { w, a, b, ca, cb } = await setup();
  const left = vi.spyOn(ca, 'call'),
    right = vi.spyOn(cb, 'call');
  const id = a.threads[0]!.id;
  await w.select(a, id);
  await w.select(b, id);
  expect(left).toHaveBeenCalledWith('threads.unsubscribe', { threadId: id });
  expect(a.visible).toBe(false);
  await w.select(a);
  expect(right).toHaveBeenCalledWith('threads.unsubscribe', { threadId: id });
  expect(a.visible).toBe(true);
  expect(left.mock.calls.filter(([m]) => m === 'threads.subscribe')).toHaveLength(2);
});

test('disconnecting the active remote keeps primary data and the view preference', async () => {
  const { w, a, b } = await setup();
  await w.select(b, b.threads[0]!.id);
  w.setView('recent');
  await w.remove('remote');
  expect(w.active).toBe(a);
  expect(a.connection).toBe('ready');
  expect(w.machines).toHaveLength(1);
  expect(localStorage.getItem('boite.thread-view')).toBe('recent');
  expect(b.client).toBeNull();
});
