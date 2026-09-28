import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ThreadSummary } from '@boite/contracts';
import ThreadState from './ThreadState.svelte';
import { threadState } from '../lib/thread-state';

type Shown = Pick<ThreadSummary, 'status' | 'unread' | 'runningSince' | 'lastUserMessageAt' | 'createdAt'>;

const NOW = Date.UTC(2026, 8, 28, 10, 0, 0);
let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function draw(thread: Partial<Shown>): HTMLElement {
  const shown: Shown = { status: 'idle', unread: false, runningSince: null, lastUserMessageAt: NOW - 120_000, createdAt: NOW - 600_000, ...thread };
  running = mount(ThreadState, { target: document.body, props: { thread: shown, now: NOW } });
  flushSync();
  return document.body.firstElementChild as HTMLElement;
}

test('each status reads as one state, and a thread at rest the user saw has none', () => {
  expect(threadState({ status: 'running', unread: false })).toBe('working');
  expect(threadState({ status: 'waiting', unread: true })).toBe('waiting');
  expect(threadState({ status: 'error', unread: false })).toBe('error');
  expect(threadState({ status: 'queued', unread: false })).toBe('queued');
  expect(threadState({ status: 'idle', unread: true })).toBe('done');
  expect(threadState({ status: 'idle', unread: false })).toBeNull();
});

test('a working thread spins and counts from its turn start, second by second', () => {
  vi.useFakeTimers({ now: NOW });
  const state = draw({ status: 'running', runningSince: NOW - 65_000 });
  expect(state.dataset['state']).toBe('working');
  expect(state.querySelector('svg')).not.toBeNull();
  expect(state.textContent?.trim()).toBe('1m 05s');
  expect(state.getAttribute('title')).toBe('Working for 1m 05s');

  vi.advanceTimersByTime(2_000);
  flushSync();
  expect(state.textContent?.trim()).toBe('1m 07s');
});

test('the other states are words in their own colour class, with no spinner', () => {
  for (const [thread, kind, word] of [
    [{ status: 'waiting' }, 'waiting', 'Needs you'],
    [{ status: 'error' }, 'error', 'Failed'],
    [{ status: 'idle', unread: true }, 'done', 'Done'],
    [{ status: 'queued' }, 'queued', 'Queued']
  ] as const) {
    const state = draw(thread);
    expect(state.dataset['state']).toBe(kind);
    expect(state.classList.contains(kind)).toBe(true);
    expect(state.querySelector('svg')).toBeNull();
    expect(state.textContent?.trim()).toBe(word);
    unmount(running!, { outro: false });
    running = null;
  }
});

test('a thread at rest shows when it was last used', () => {
  const when = draw({});
  expect(when.dataset['testid']).toBeUndefined();
  expect(when.classList.contains('when')).toBe(true);
  expect(when.textContent?.trim().length).toBeGreaterThan(0);
});
