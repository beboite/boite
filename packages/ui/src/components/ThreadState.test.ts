import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ThreadSummary } from '@boite/contracts';
import ThreadState from './ThreadState.svelte';
import { projectRollup, threadState } from '../lib/thread-state';

type Shown = Pick<ThreadSummary, 'status' | 'unread' | 'runningSince' | 'backgroundWork' | 'lastUserMessageAt' | 'createdAt'>;

const NOW = Date.UTC(2026, 8, 28, 10, 0, 0);
let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function draw(thread: Partial<Shown>): HTMLElement {
  const shown: Shown = { status: 'idle', unread: false, runningSince: null, backgroundWork: null, lastUserMessageAt: NOW - 120_000, createdAt: NOW - 600_000, ...thread };
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

test('a finished turn whose agent still runs something is not at rest, read or not', () => {
  const monitor = { kinds: ['monitor' as const], since: NOW };
  expect(threadState({ status: 'idle', unread: false, backgroundWork: monitor })).toBe('monitoring');
  expect(threadState({ status: 'idle', unread: true, backgroundWork: monitor })).toBe('monitoring');
  expect(threadState({ status: 'idle', unread: false, backgroundWork: { kinds: ['monitor', 'shell'], since: NOW } })).toBe('background');
  expect(threadState({ status: 'idle', unread: true, backgroundWork: { kinds: [], since: NOW } })).toBe('done');
  // A running turn says working whatever it left in the background.
  expect(threadState({ status: 'running', unread: false, backgroundWork: monitor })).toBe('working');
});

test('a monitoring thread counts from its oldest task and says what still runs', () => {
  vi.useFakeTimers({ now: NOW });
  const state = draw({ status: 'idle', unread: true, backgroundWork: { kinds: ['monitor', 'monitor'], since: NOW - 125_000 } });
  expect(state.dataset['state']).toBe('monitoring');
  expect(state.classList.contains('monitoring')).toBe(true);
  expect(state.querySelector('svg')).not.toBeNull();
  expect(state.textContent?.trim()).toBe('2m 05s');
  expect(state.getAttribute('title')).toBe('Monitoring for 2m 05s\n2 monitors still running');

  vi.advanceTimersByTime(1_000);
  flushSync();
  expect(state.textContent?.trim()).toBe('2m 06s');
});

test('a shell left running reads as background work, with a pulse rather than a spinner', () => {
  vi.useFakeTimers({ now: NOW });
  const state = draw({ status: 'idle', backgroundWork: { kinds: ['shell', 'monitor'], since: NOW - 5_000 } });
  expect(state.dataset['state']).toBe('background');
  expect(state.querySelector('svg')).toBeNull();
  expect(state.querySelector('.dot.pulse')).not.toBeNull();
  expect(state.getAttribute('title')).toBe(`In background for ${state.textContent?.trim()}\n1 shell, 1 monitor still running`);
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

test('a folded project names its most urgent state and how many threads share it', () => {
  const idle = { status: 'idle' as const, unread: false };
  expect(projectRollup([idle, idle])).toBeNull();
  expect(projectRollup([{ status: 'idle', unread: true }, idle])).toEqual({ kind: 'done', count: 1 });
  expect(projectRollup([{ status: 'running', unread: false }, { status: 'running', unread: false }, { status: 'idle', unread: true }])).toEqual({ kind: 'working', count: 2 });
  expect(projectRollup([{ status: 'running', unread: false }, { status: 'error', unread: false }])).toEqual({ kind: 'error', count: 1 });
  expect(projectRollup([{ status: 'error', unread: false }, { status: 'waiting', unread: false }])).toEqual({ kind: 'waiting', count: 1 });
  expect(projectRollup([{ status: 'idle', unread: true, backgroundWork: { kinds: ['monitor'], since: NOW } }, { status: 'idle', unread: true }])).toEqual({ kind: 'monitoring', count: 1 });
});
