import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import ChatView from './ChatView.svelte';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.replaceChildren();
});

const notice = () => document.querySelector('[data-testid=worktree-gone]');

test('a thread whose worktree was removed says so while done, and after it is moved back to Recent', async ({ ready }) => {
  const { store, client } = await ready();
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: account.id, title: 'Merged work', worktree: { branch: 'boite/merged-work' } });
  await client.call('threads.archive', { threadId: thread.id });
  client.removeWorktree(thread.id, { branch: 'boite/merged-work', branchDeleted: true, reason: 'pr-merged', pullRequest: { number: 12, url: 'https://github.com/example/repo/pull/12' }, removedAt: Date.now() - 2 * 3_600_000 });
  await store.open(thread.id);
  view = mount(ChatView, { target: document.body, props: { store } });
  flushSync();

  await vi.waitFor(() => expect(notice()).not.toBeNull());
  expect(notice()!.textContent).toContain('after #12 was merged');
  expect(notice()!.textContent).toContain('Branch boite/merged-work was deleted.');
  expect(notice()!.textContent).toContain('Moved to Recent, this thread has no folder to work in.');
  expect(notice()!.querySelector('a')?.getAttribute('href')).toBe('https://github.com/example/repo/pull/12');
  expect(document.querySelector('[data-testid=done-thread-notice]')).not.toBeNull();

  document.querySelector<HTMLButtonElement>('[data-testid=done-thread-reopen]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid=done-thread-notice]')).toBeNull());
  flushSync();
  expect(notice()!.textContent).toContain('A new message here has no folder to run in.');
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'still there?' })).rejects.toThrow();
});

test('a clean removal names no pull request and says when the branch stayed', async ({ ready }) => {
  const { store, client } = await ready();
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: account.id, title: 'Clean work', worktree: { branch: 'boite/clean-work' } });
  client.removeWorktree(thread.id, { branch: 'boite/clean-work', branchDeleted: false, reason: 'clean', removedAt: Date.now() });
  await store.open(thread.id);
  view = mount(ChatView, { target: document.body, props: { store } });
  flushSync();

  await vi.waitFor(() => expect(notice()).not.toBeNull());
  expect(notice()!.textContent).toContain('every commit in it was already on another branch');
  expect(notice()!.textContent).toContain('Branch boite/clean-work is still there.');
  expect(notice()!.querySelector('a')).toBeNull();
});
