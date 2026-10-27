import { afterEach, expect, test, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import type { Store } from '../../lib/store.svelte';
import { setExperiment } from '../../lib/experiments';
import { sharedProjectThreads } from '../../lib/deferred-parts';
import SharedProjectThreads from './SharedProjectThreads.svelte';
import Loader from './SharedProjectThreadsLoader.svelte';

let running: Record<string, unknown> | undefined;
afterEach(() => {
  if (running) unmount(running);
  running = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  sharedProjectThreads.current = undefined;
  sharedProjectThreads.failed = false;
  setExperiment('contacts', false);
});

test('local threads survive a pending or failed shared chunk and appear once after retry', async () => {
  setExperiment('contacts', true);
  let reject!: () => void;
  const load = vi.spyOn(sharedProjectThreads, 'load')
    .mockImplementationOnce(() => new Promise((_resolve, fail) => {
      reject = () => { sharedProjectThreads.failed = true; fail(new Error('offline')); };
    }))
    .mockImplementationOnce(async () => {
      sharedProjectThreads.failed = false;
      sharedProjectThreads.current = SharedProjectThreads;
      return SharedProjectThreads;
    });
  const store = { projectBoardThread: () => undefined, threadsOf: () => [], connection: 'offline' } as unknown as Store;
  running = mount(Loader, { target: document.body, props: {
    store, projectId: 'local', active: true,
    children: createRawSnippet(() => ({ render: () => '<button data-testid="local-thread">Local thread</button>' })),
  } });
  flushSync();
  expect(document.querySelectorAll('[data-testid=local-thread]')).toHaveLength(1);
  reject();
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')).not.toBeNull());
  expect(document.querySelectorAll('[data-testid=local-thread]')).toHaveLength(1);
  document.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')).toBeNull());
  expect(load).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll('[data-testid=local-thread]')).toHaveLength(1);
});

test('a project with Contacts off needs no shared chunk to show its local threads', () => {
  const load = vi.spyOn(sharedProjectThreads, 'load');
  running = mount(Loader, { target: document.body, props: {
    store: {} as Store, projectId: 'local', active: true,
    children: createRawSnippet(() => ({ render: () => '<button data-testid="local-thread">Local thread</button>' })),
  } });
  flushSync();
  expect(document.querySelector('[data-testid=local-thread]')).not.toBeNull();
  expect(load).not.toHaveBeenCalled();
});
