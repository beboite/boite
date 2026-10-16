import { expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { threadState } from '../lib/thread-state';
import TasksSurface from './TasksSurface.svelte';
import ThreadHeader from './ThreadHeader.svelte';

const URL = 'https://github.com/example/repo/pull/7';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await tick();
  }
  flushSync();
}

test('the panel lists the pull requests a thread watches with what the last read saw, and stops one', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const component = mount(TasksSurface, { target: document.body, props: { store } });
  try {
    await settle();
    // No watch, no section.
    expect(document.querySelector('[data-testid=tasks-section-watches]')).toBeNull();
    await expect(client.call('threads.watchPullRequest', { threadId: 't-trace' })).rejects.toThrow('no linked pull request');
    await client.call('threads.watchPullRequest', { threadId: 't-trace', url: URL });
    await settle();
    const row = document.querySelector<HTMLElement>('[data-testid=pr-watch]')!;
    expect(row.querySelector('a')!.getAttribute('href')).toBe(URL);
    expect(row.textContent).toContain('#7');
    expect(row.textContent).toContain('4 checks · 2 running');
    // A thread at rest with a watch reads as watching, not done, read or not.
    expect(threadState(store.openThread!)).toBe('watching');
    expect(threadState({ ...store.openThread!, unread: true })).toBe('watching');

    row.querySelector<HTMLButtonElement>('[data-testid=pr-watch-stop]')!.click();
    await settle();
    expect(document.querySelector('[data-testid=pr-watch]')).toBeNull();
    expect(store.openThread!.pullRequestWatches).toEqual([]);

    // Stop on the thread ends its watches too.
    await client.call('threads.watchPullRequest', { threadId: 't-trace', url: '7' });
    expect((await client.call('turns.stop', { threadId: 't-trace' })).stopped).toBe(true);
    await settle();
    expect(document.querySelector('[data-testid=pr-watch]')).toBeNull();
  } finally {
    await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = ''; window.localStorage.clear();
  }
});

test('the thread header shows the watches with their status and stops one from its menu, phones included', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const component = mount(ThreadHeader, { target: document.body, props: { store } });
  try {
    await settle();
    expect(document.querySelector('[data-testid=thread-watches]')).toBeNull();
    await client.call('threads.watchPullRequest', { threadId: 't-trace', url: URL });
    await settle();
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid=thread-watches-trigger]')!;
    expect(trigger.textContent).toContain('#7');
    trigger.click();
    await settle();
    const item = document.querySelector<HTMLElement>('[data-testid=thread-watches-trigger-menu] [role=menuitem]')!;
    expect(item.textContent).toContain('Stop watching #7');
    expect(item.textContent).toContain('4 checks · 2 running');
    item.click();
    await settle();
    expect(store.openThread!.pullRequestWatches).toEqual([]);
    expect(document.querySelector('[data-testid=thread-watches]')).toBeNull();
  } finally {
    await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = ''; window.localStorage.clear();
  }
});

