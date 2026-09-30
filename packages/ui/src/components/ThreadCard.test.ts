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
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
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
