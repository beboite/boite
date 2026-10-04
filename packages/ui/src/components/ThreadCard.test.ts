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

test('a PR opened during a turn appears without remounting and refresh failures keep its link', async () => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  const thread = store.threads.find(thread => thread.branch)!;
  thread.status = 'running';
  const project = store.projects.find(project => project.id === thread.projectId)!;
  const pr = { number: 181, url: 'https://github.com/example/repo/pull/181', state: 'OPEN' as const };
  const call = vi.spyOn(client, 'call').mockResolvedValueOnce(null).mockResolvedValueOnce(pr).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...pr, state: 'MERGED' });
  vi.useFakeTimers();
  mounted = mount(ThreadCard, { target: document.body, props: { machine: { id: 'local', label: 'Local', store }, project, thread, now: Date.now(), showProject: false } });
  await settle();
  expect(document.querySelector('[data-testid=thread-pr]')).toBeNull();
  await vi.advanceTimersByTimeAsync(15_000); await settle();
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#181');
  await vi.advanceTimersByTimeAsync(15_000); await settle();
  expect(document.querySelector('[data-testid=thread-pr]')?.textContent).toContain('#181');
  expect(store.error).toBeNull();
  thread.status = 'idle'; await settle();
  expect(call).toHaveBeenCalledTimes(4);
  const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(30_000); await settle();
  expect(call).toHaveBeenCalledTimes(4);
  visibility.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); await settle();
  expect(call).toHaveBeenCalledTimes(5);
  await unmount(mounted); mounted = undefined;
  await vi.advanceTimersByTimeAsync(30_000); await settle();
  expect(call).toHaveBeenCalledTimes(5);
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
