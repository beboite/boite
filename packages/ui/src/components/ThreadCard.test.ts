import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import ThreadCard from './ThreadCard.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let client: FakeClient;
let store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  store?.detach(); client?.close();
  vi.useRealTimers();
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
});

test('a card asks every minute at rest and every 15 s at work, and a merged PR is not asked about again until a manual refresh', async () => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  const thread = store.threads.find(thread => thread.branch)!;
  // Its own checkout: the page keeps the merged answer for it, which later tests must not start from.
  thread.branch = 'merged-topic';
  thread.status = 'idle';
  const project = store.projects.find(project => project.id === thread.projectId)!;
  const pr = { number: 181, url: 'https://github.com/example/repo/pull/181', state: 'OPEN' as const };
  const call = vi.spyOn(client, 'call').mockResolvedValueOnce(null).mockResolvedValueOnce(pr).mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(pr).mockResolvedValue({ ...pr, state: 'MERGED' });
  vi.useFakeTimers();
  mounted = mount(ThreadCard, { target: document.body, props: { machine: { id: 'local', label: 'Local', store }, project, thread, now: Date.now(), showProject: false } });
  await settle();
  expect(call).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid=thread-pr]')).toBeNull();
  // The core keeps a repository's list for 15 s: asking that often about a thread at rest ran `gh` at every round.
  await vi.advanceTimersByTimeAsync(15_000); await settle();
  expect(call).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(45_000); await settle();
  expect(call).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#181');
  await vi.advanceTimersByTimeAsync(60_000); await settle();
  expect(call).toHaveBeenCalledTimes(3);
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#181');
  expect(store.error).toBeNull();
  // A turn starts: it asks at once, then every 15 s while the thread works.
  thread.status = 'running'; await settle();
  expect(call).toHaveBeenCalledTimes(4);
  const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(120_000); await settle();
  expect(call).toHaveBeenCalledTimes(4);
  visibility.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); await settle();
  expect(call).toHaveBeenCalledTimes(5);
  // Merged stays merged: neither the rounds nor a finished turn ask again.
  await vi.advanceTimersByTimeAsync(120_000); await settle();
  thread.status = 'idle'; await settle();
  await vi.advanceTimersByTimeAsync(120_000); await settle();
  expect(call).toHaveBeenCalledTimes(5);
  // The user's own refresh still does.
  const { contextMenu } = await import('../lib/context-menu.svelte');
  document.querySelector('[data-testid=thread-row]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }));
  contextMenu.current!.onpick('pr'); contextMenu.close(); await settle();
  expect(call).toHaveBeenCalledTimes(6);
  expect(call).toHaveBeenLastCalledWith('threads.pullRequest', { threadId: thread.id, refresh: true });
  await unmount(mounted); mounted = undefined;
  await vi.advanceTimersByTimeAsync(120_000); await settle();
  expect(call).toHaveBeenCalledTimes(6);
});

test('cards on screen share one round a minute, none while the page is hidden, and one on return', async () => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  const source = store.threads.find(thread => thread.branch)!;
  const project = store.projects.find(project => project.id === source.projectId)!;
  const call = vi.spyOn(client, 'call').mockResolvedValue(null);
  const lookups = () => call.mock.calls.filter(([method]) => method === 'threads.pullRequest').length;
  vi.useFakeTimers();
  const cards = Array.from({ length: 10 }, (_, index) => mount(ThreadCard, { target: document.body,
    props: { machine: { id: 'local', label: 'Local', store }, project, thread: { ...source, id: `t-card-${index}`, branch: `topic-${index}`, status: 'idle' as const }, now: Date.now(), showProject: false } }));
  try {
    await settle();
    expect(lookups()).toBe(10);
    call.mockClear();
    await vi.advanceTimersByTimeAsync(120_000); await settle();
    expect(lookups()).toBe(20);
    call.mockClear();
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000); await settle();
    expect(lookups()).toBe(0);
    visibility.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(lookups()).toBe(10);
    // Back again before a round is due: nothing more until it is.
    visibility.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(lookups()).toBe(10);
    await vi.advanceTimersByTimeAsync(60_000); await settle();
    expect(lookups()).toBe(20);
  } finally {
    for (const card of cards) await unmount(card);
  }
});

test('moving a thread clears its PR and ignores the previous checkout lookup', async () => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  const thread = store.threads.find(thread => thread.branch)!;
  const project = store.projects.find(project => project.id === thread.projectId)!;
  const previous = { number: 180, url: 'https://github.com/example/repo/pull/180', state: 'OPEN' as const };
  let answer!: (value: typeof previous) => void;
  const pending = new Promise<typeof previous>(resolve => { answer = resolve; });
  const call = vi.spyOn(client, 'call').mockResolvedValueOnce(previous).mockReturnValueOnce(pending);
  mounted = mount(ThreadCard, { target: document.body, props: { machine: { id: 'local', label: 'Local', store }, project, thread, now: Date.now(), showProject: false } });
  await settle();
  expect(call).toHaveBeenCalledWith('threads.pullRequest', { threadId: thread.id });
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#180');
  thread.branch = 'new-topic';
  thread.cwd = '/new-worktree';
  await settle();
  expect(document.querySelector('[data-testid=thread-pr]')).toBeNull();
  expect(call).toHaveBeenCalledTimes(2);
  thread.branch = null;
  thread.cwd = project.path;
  await settle();
  answer(previous); await settle();
  expect(document.querySelector('[data-testid=thread-pr]')).toBeNull();
  expect(document.querySelector('.metadata')).toBeNull();
});

test('a reconnect keeps the PR line on screen while the core is asked again', async () => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  const thread = store.threads.find(thread => thread.branch)!;
  const project = store.projects.find(project => project.id === thread.projectId)!;
  const held = { number: 181, url: 'https://github.com/example/repo/pull/181', state: 'OPEN' as const };
  const pending = new Promise<typeof held>(() => undefined);
  const call = vi.spyOn(client, 'call').mockResolvedValueOnce(held).mockReturnValueOnce(pending);
  mounted = mount(ThreadCard, { target: document.body, props: { machine: { id: 'local', label: 'Local', store }, project, thread, now: Date.now(), showProject: false } });
  await settle();
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#181');
  store.connection = 'connecting';
  await settle();
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#181');
  store.connection = 'ready';
  await settle();
  // The second lookup is out and unanswered: the line it will confirm never left.
  expect(call).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#181');
  expect(document.querySelector('.metadata')).not.toBeNull();
});

test('a turn left running on a machine that went away stops spinning until the machine is back', async () => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  vi.spyOn(client, 'call').mockResolvedValue(null);
  const thread = store.threads.find(thread => thread.status === 'idle')!;
  thread.status = 'running';
  thread.runningSince = Date.now() - 3 * 3_600_000;
  const project = store.projects.find(project => project.id === thread.projectId)!;
  mounted = mount(ThreadCard, { target: document.body, props: { machine: { id: 'laptop', label: 'Laptop', store }, project, thread, now: Date.now(), showProject: false } });
  await settle();
  const state = () => document.querySelector<HTMLElement>('[data-testid=thread-state]');
  expect(state()?.dataset.state).toBe('working');
  expect(state()?.querySelector('.spinner')).not.toBeNull();
  store.connection = 'connecting'; await settle();
  expect(state()?.dataset.state).toBe('unreachable');
  expect(state()?.querySelector('.spinner')).toBeNull();
  expect(state()?.getAttribute('title')).toBe('Machine unreachable. Last known state: Working');
  store.connection = 'ready'; await settle();
  expect(state()?.dataset.state).toBe('working');
});
