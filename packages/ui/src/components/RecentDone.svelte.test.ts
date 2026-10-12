import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import type { ProjectEntry } from '../lib/project-view.svelte';
import { projectName } from '../lib/format';
import type { ThreadSummary } from '@boite/contracts';
import RecentDone from './RecentDone.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const sources: { client: FakeClient; store: Store; id: string }[] = [];
// The row component loads on its own with the first rows: loaded once here, later imports resolve in the same turn.
const settle = async () => { await import('./DoneThread.svelte'); for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted); mounted = undefined;
  for (const source of sources.splice(0)) { source.store.detach(); source.client.close(); }
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
});

async function ready(id: string) {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  // Marked done; the seeded t-parser stays an ordinary archive.
  await store.archive('t-trace', true);
  const source = { client, store, id }; sources.push(source);
  return source;
}
function entries(): ProjectEntry[] {
  return sources.map(source => ({ machine: { id: source.id, label: source.id, store: source.store }, project: source.store.projects.find(project => project.id === 'p-boite')! }));
}
function click(selector: string): void { (document.querySelector(selector) as HTMLButtonElement).click(); }

test('Done loads only when expanded and restores the owning machine when thread and project ids collide', async () => {
  const first = await ready('first'), second = await ready('second');
  const calls = sources.map(source => vi.spyOn(source.client, 'call'));
  const props = $state({ entries: entries(), now: Date.now() });
  mounted = mount(RecentDone, { target: document.body, props });
  await settle();
  for (const call of calls) expect(call.mock.calls.filter(([method]) => method === 'threads.list')).toHaveLength(0);
  click('[data-testid=recent-done-toggle]'); await settle();
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(2);
  // The project shows beside the row, and the row's button names it too, for a screen reader moving between buttons.
  const project = projectName(entries()[0]!.project);
  expect(document.querySelector('[data-machine-id=first][data-thread-id=t-trace] [data-testid=done-thread-open]')?.textContent).toContain(project);
  click('[data-machine-id=first][data-thread-id=t-trace] [data-testid=done-thread-restore]'); await settle();
  expect((await first.client.call('threads.get', { threadId: 't-trace' })).archived).toBe(false);
  expect((await second.client.call('threads.get', { threadId: 't-trace' })).archived).toBe(true);
  props.entries = entries(); await settle();
  expect(document.querySelector('[data-machine-id=first][data-thread-id=t-trace]')).toBeNull();
  expect(document.querySelector('[data-machine-id=second][data-thread-id=t-trace]')).not.toBeNull();
});

test('a project counter loads only its project when externally expanded', async () => {
  const source = await ready('first');
  const call = vi.spyOn(source.client, 'call');
  const props = $state({ entries: entries(), now: Date.now(), header: false, open: false });
  mounted = mount(RecentDone, { target: document.body, props });
  await settle();
  expect(document.querySelector('[data-testid=recent-done-toggle]')).toBeNull();
  expect(call.mock.calls.filter(([method]) => method === 'threads.list')).toHaveLength(0);
  props.open = true; await settle();
  expect(call).toHaveBeenCalledWith('threads.list', { projectId: 'p-boite', includeArchived: true });
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(1);
  props.open = false; await settle();
  expect(document.querySelector('[data-testid=done-thread]')).toBeNull();
});

test('a late archive read for a previous project or machine never replaces the selected machine', async () => {
  const first = await ready('first'); await ready('second');
  const answer = await first.client.call('threads.list', { includeArchived: true });
  let release!: (value: ThreadSummary[]) => void;
  const pending = new Promise<ThreadSummary[]>(resolve => { release = resolve; });
  const call = first.client.call.bind(first.client) as FakeClient['call'];
  vi.spyOn(first.client, 'call').mockImplementation((method, params) => method === 'threads.list' ? pending as never : call(method, params as never));
  const props = $state({ entries: [entries()[0]!], now: Date.now() });
  mounted = mount(RecentDone, { target: document.body, props });
  click('[data-testid=recent-done-toggle]'); await settle();
  props.entries = [entries()[1]!]; await settle();
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(1);
  release(answer); await settle();
  expect([...document.querySelectorAll('[data-testid=done-thread]')].every(row => (row as HTMLElement).dataset.machineId === 'second')).toBe(true);
});

test('a failed machine read keeps the other completed threads usable and can be retried', async () => {
  const first = await ready('first'); await ready('second');
  vi.spyOn(first.client, 'call').mockRejectedValueOnce(new Error('offline'));
  mounted = mount(RecentDone, { target: document.body, props: { entries: entries(), now: Date.now() } });
  click('[data-testid=recent-done-toggle]'); await settle();
  expect(document.querySelector('[data-testid=recent-done-retry]')).not.toBeNull();
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(1);
  click('[data-testid=recent-done-retry]'); await settle();
  expect(document.querySelector('[data-testid=recent-done-retry]')).toBeNull();
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(2);
});

test('done and archived threads are separate lists with their own counts', async () => {
  const source = await ready('first');
  const project = source.store.projects.find(p => p.id === 'p-boite')!;
  expect([project.archivedThreads, project.doneThreads]).toEqual([2, 1]);
  mounted = mount(RecentDone, { target: document.body, props: { entries: entries(), now: Date.now(), kind: 'archived' } });
  await settle();
  expect(document.querySelector('[data-testid=recent-archived-toggle] .fold-count')?.textContent).toBe('1');
  click('[data-testid=recent-archived-toggle]'); await settle();
  expect([...document.querySelectorAll('[data-testid=done-thread]')].map(row => (row as HTMLElement).dataset.threadId)).toEqual(['t-parser']);
  await unmount(mounted);
  mounted = mount(RecentDone, { target: document.body, props: { entries: entries(), now: Date.now() } });
  click('[data-testid=recent-done-toggle]'); await settle();
  expect([...document.querySelectorAll('[data-testid=done-thread]')].map(row => (row as HTMLElement).dataset.threadId)).toEqual(['t-trace']);
});

test('archived threads are listed by when they were put away, not by their last change', async () => {
  const source = await ready('first');
  await source.store.archive('t-bench');
  const call = source.client.call.bind(source.client);
  // t-parser was archived long ago but changed since: its last change must not lift it.
  vi.spyOn(source.client, 'call').mockImplementation((async (method: string, params: unknown) => {
    const result = await call(method as never, params as never);
    if (method !== 'threads.list') return result;
    return (result as ThreadSummary[]).map(t => t.id === 't-parser' ? { ...t, archivedAt: 1, updatedAt: Date.now() + 60_000 } : t);
  }) as never);
  mounted = mount(RecentDone, { target: document.body, props: { entries: entries(), now: Date.now(), kind: 'archived' } });
  click('[data-testid=recent-archived-toggle]'); await settle();
  expect([...document.querySelectorAll('[data-testid=done-thread]')].map(row => (row as HTMLElement).dataset.threadId)).toEqual(['t-bench', 't-parser']);
  expect(document.querySelector('[data-thread-id=t-parser] time')?.getAttribute('datetime')).toBe(new Date(1).toISOString());
});

test('a done thread is deleted from its own menu, opened by right click or a long press', async () => {
  const source = await ready('first');
  const props = $state({ entries: entries(), now: Date.now(), header: false, open: true });
  mounted = mount(RecentDone, { target: document.body, props });
  await settle();
  const { contextMenu } = await import('../lib/context-menu.svelte');
  const row = document.querySelector('[data-testid=done-thread][data-thread-id=t-trace]') as HTMLElement;
  const rightClick = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 });
  row.dispatchEvent(rightClick);
  // The browser's own menu, the one a link would get, stays shut.
  expect(rightClick.defaultPrevented).toBe(true);
  expect(contextMenu.current?.items.filter(item => !item.separator).map(item => item.id)).toEqual(['open', 'restore', 'pr', 'copy', 'delete']);
  contextMenu.close();
  // No menu button on the row: a finger held on it opens the same menu, and the click that ends the press opens nothing.
  expect(row.querySelector('[data-testid=done-thread-menu]')).toBeNull();
  vi.useFakeTimers();
  const touch = (type: string) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 14, clientY: 14 });
    Object.defineProperties(event, { pointerType: { value: 'touch' }, isPrimary: { value: true } });
    return event;
  };
  row.querySelector('[data-testid=done-thread-open]')!.dispatchEvent(touch('pointerdown'));
  vi.advanceTimersByTime(499);
  expect(contextMenu.current).toBeNull();
  vi.advanceTimersByTime(1);
  vi.useRealTimers();
  expect(contextMenu.current?.items.filter(item => !item.separator).map(item => item.id)).toEqual(['open', 'restore', 'pr', 'copy', 'delete']);
  const select = vi.spyOn(source.store, 'open');
  click('[data-thread-id=t-trace] [data-testid=done-thread-open]');
  expect(select).not.toHaveBeenCalled();
  const removals = vi.spyOn(source.client, 'call');
  // Picked twice before the core answers: one request, no refusal banner.
  const pick = contextMenu.current!.onpick;
  // Refused by the core: the banner says so and the row can be tried again.
  removals.mockRejectedValueOnce(new Error('refused'));
  pick('delete'); await settle();
  expect(source.store.error).toBe('refused');
  expect((document.querySelector('[data-thread-id=t-trace] [data-testid=done-thread-open]') as HTMLButtonElement).disabled).toBe(false);
  source.store.error = null; removals.mockClear();
  pick('delete'); pick('delete'); contextMenu.close(); flushSync();
  expect((document.querySelector('[data-thread-id=t-trace] [data-testid=done-thread-open]') as HTMLButtonElement).disabled).toBe(true);
  // Reopened while the core has not answered, and after it has: the row offers nothing more.
  const locked = () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
    const items = contextMenu.current!.items.filter(item => ['open', 'restore', 'delete'].includes(item.id)).map(item => item.disabled);
    contextMenu.close();
    return items;
  };
  expect(locked()).toEqual([true, true, true]);
  await settle();
  expect(locked()).toEqual([true, true, true]);
  expect(removals.mock.calls.filter(([method]) => method === 'threads.remove')).toHaveLength(1);
  expect(source.store.error).toBeNull();
  await expect(source.client.call('threads.get', { threadId: 't-trace' })).rejects.toThrow();
  props.entries = entries(); await settle();
  expect(document.querySelector('[data-testid=done-thread]')).toBeNull();
});
