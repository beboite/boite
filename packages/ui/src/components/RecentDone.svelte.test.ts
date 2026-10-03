import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import type { ProjectEntry } from '../lib/project-view.svelte';
import type { ThreadSummary } from '@boite/contracts';
import RecentDone from './RecentDone.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const sources: { client: FakeClient; store: Store; id: string }[] = [];
const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted); mounted = undefined;
  for (const source of sources.splice(0)) { source.store.detach(); source.client.close(); }
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
});

async function ready(id: string) {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  await store.archive('t-trace');
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
  for (const call of calls) expect(call).not.toHaveBeenCalledWith('threads.list', { includeArchived: true });
  click('[data-testid=recent-done-toggle]'); await settle();
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(4);
  click('[data-machine-id=first][data-thread-id=t-trace] [data-testid=done-thread-restore]'); await settle();
  expect((await first.client.call('threads.get', { threadId: 't-trace' })).archived).toBe(false);
  expect((await second.client.call('threads.get', { threadId: 't-trace' })).archived).toBe(true);
  props.entries = entries(); await settle();
  expect(document.querySelector('[data-machine-id=first][data-thread-id=t-trace]')).toBeNull();
  expect(document.querySelector('[data-machine-id=second][data-thread-id=t-trace]')).not.toBeNull();
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
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(2);
  release(answer); await settle();
  expect([...document.querySelectorAll('[data-testid=done-thread]')].every(row => (row as HTMLElement).dataset.machineId === 'second')).toBe(true);
});

test('a failed machine read keeps the other completed threads usable and can be retried', async () => {
  const first = await ready('first'); await ready('second');
  vi.spyOn(first.client, 'call').mockRejectedValueOnce(new Error('offline'));
  mounted = mount(RecentDone, { target: document.body, props: { entries: entries(), now: Date.now() } });
  click('[data-testid=recent-done-toggle]'); await settle();
  expect(document.querySelector('[data-testid=recent-done-retry]')).not.toBeNull();
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(2);
  click('[data-testid=recent-done-retry]'); await settle();
  expect(document.querySelector('[data-testid=recent-done-retry]')).toBeNull();
  expect(document.querySelectorAll('[data-testid=done-thread]')).toHaveLength(4);
});
