import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import ThreadPullRequests from './ThreadPullRequests.svelte';
import { writeExperiments } from '../lib/experiments';

let app: ReturnType<typeof mount> | undefined, client: FakeClient, store: Store;
const settle = async () => { for (let i = 0; i < 25; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => { if (app) await unmount(app); app = undefined; store?.detach(); client?.close(); vi.restoreAllMocks(); document.body.innerHTML = ''; writeExperiments([]); localStorage.clear(); });

test('explicit links update the open conversation and unlink without removing another thread’s links', async () => {
  // jsdom does not implement the native dialog API; native E2E covers its stacking.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  const threadId = 't-trace', other = store.threads.find(thread => thread.id !== threadId)!.id;
  const url = 'https://github.com/example/repo/pull/101';
  await client.call('threads.subscribe', { threadId });
  await client.call('threads.linkPullRequest', { threadId: other, url });
  app = mount(ThreadPullRequests, { target: document.body, props: { store, threadId } }); await settle();
  expect(document.querySelector('[data-testid=thread-prs]')!.textContent!.trim()).toBe('');
  (document.querySelector('[data-testid=thread-prs]') as HTMLButtonElement).click(); await settle();
  const input = document.querySelector<HTMLInputElement>('[data-testid=thread-pr-url]')!;
  input.value = url; input.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
  input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  expect(document.querySelector('[data-testid=linked-pr]')!.textContent).toContain('#101');
  expect(document.querySelector('[data-testid=thread-prs]')!.textContent).toContain('1');
  await client.call('threads.linkPullRequest', { threadId, url: url + '?tab=files' }); await settle();
  expect(document.querySelectorAll('[data-testid=linked-pr]')).toHaveLength(1);
  (document.querySelector('[data-testid=linked-pr] button') as HTMLButtonElement).click(); await settle();
  expect(document.querySelectorAll('[data-testid=linked-pr]')).toHaveLength(0);
  expect(await client.call('threads.pullRequests', { threadId: other })).toHaveLength(1);
});

test('the experimental review opens files, comments and checks without writing to GitHub', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  const threadId = 't-trace', url = 'https://github.com/example/repo/pull/102';
  await client.call('threads.subscribe', { threadId }); await client.call('threads.linkPullRequest', { threadId, url });
  app = mount(ThreadPullRequests, { target: document.body, props: { store, threadId } }); await settle();
  (document.querySelector('[data-testid=thread-prs]') as HTMLButtonElement).click(); await settle();
  expect(document.querySelector('[data-testid=pr-read]')).toBeNull();
  writeExperiments(['pr-review']); await settle();
  (document.querySelector('[data-testid=pr-read]') as HTMLButtonElement).click(); await settle();
  expect(document.querySelector('[data-testid=pr-review]')?.textContent).toContain('Pull request 102');
  (document.querySelector('[data-testid=pr-review-files]') as HTMLButtonElement).click(); await settle();
  (document.querySelector('.file-head') as HTMLButtonElement).click(); await settle();
  expect(document.querySelector('.patch')?.textContent).toContain('+const width = 390;');
  (document.querySelector('[data-testid=pr-review-comments]') as HTMLButtonElement).click(); await settle();
  expect(document.querySelector('.comment')?.textContent).toContain('Check the layout on a phone.');
  (document.querySelector('[data-testid=pr-review-checks]') as HTMLButtonElement).click(); await settle();
  expect(document.querySelector('.checks')?.textContent).toContain('SUCCESS');
  writeExperiments([]); await settle();
  expect(document.querySelector('[data-testid=pr-review]')).toBeNull();
  expect(document.querySelectorAll('[data-testid=linked-pr]')).toHaveLength(1);
});
