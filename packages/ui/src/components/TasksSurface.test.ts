import { expect, test, vi } from 'vitest';
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
    // A thread at rest with a watch whose checks still run reads as watching, not done, read or not.
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


test('a reviewed goal\'s checklist and reviews have their own sections in the panel', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  store.openThread!.activity = { tasks: [], loop: null, goal: { objective: 'Ship it', status: 'active', iterations: 2, error: null,
    review: { phase: 'working', maxRounds: 5, reviewerThreadId: null, claimTurnId: null, delivered: 1, verdicts: [
      { round: 1, verdict: 'fail', summary: '- The CSV export drops the totals', threadId: 'reviewer-1', finishedAt: 1 },
      { round: 2, verdict: 'pass', summary: 'Both exports work.', threadId: 'reviewer-2', finishedAt: 2 },
    ] },
    checklist: { threadId: null, phase: 'idle', model: null, effort: null, error: null, items: [
      { id: 1, text: 'Add a dark theme', source: 'dark theme', status: 'done' },
      { id: 2, text: 'Export invoices as CSV', source: 'CSV', status: 'open' },
      { id: 3, text: 'Mail the invoices', source: 'mail', status: 'cancelled' },
    ] } } };
  const component = mount(TasksSurface, { target: document.body, props: { store } });
  try {
    await settle();
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid=tasks-checklist] [data-testid=goal-checklist-item]')).toHaveLength(3));
    expect(document.querySelector('[data-testid=tasks-section-checklist]')!.textContent).toContain('1/2 done');
    expect(document.querySelector('[data-testid=tasks-checklist] [data-testid=goal-checklist]')!.classList.contains('dense')).toBe(true);
    // The bar keeps only the verdict dots: the panel lists each review, newest first, with what it found.
    const reviews = [...document.querySelectorAll<HTMLElement>('[data-testid=tasks-review]')];
    expect(reviews.map(review => review.dataset.verdict)).toEqual(['pass', 'fail']);
    expect(reviews[1]!.textContent).toContain('- The CSV export drops the totals');
    const open = vi.spyOn(store, 'open').mockResolvedValue(undefined as never);
    reviews[1]!.querySelector<HTMLButtonElement>('button')!.click();
    expect(open).toHaveBeenCalledWith('reviewer-1');
  } finally {
    unmount(component);
    document.body.innerHTML = '';
  }
});
