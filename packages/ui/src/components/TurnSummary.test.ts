import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BackgroundTask, Message, Turn } from '@boite/contracts';
import TurnSummary from './TurnSummary.svelte';
import MessageTurnSummary from './MessageTurnSummary.svelte';
import type { Store } from '../lib/store.svelte';
import { clockTime } from '../lib/format';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const STARTED = new Date(2026, 8, 24, 10, 26, 30).getTime();

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-1',
    threadId: 't-1',
    status: 'done',
    queuedAt: STARTED,
    startedAt: STARTED,
    finishedAt: STARTED + 281_000,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 40_000, cacheWriteTokens: 0, costUsdEquivalent: 0.1 },
    error: null,
    ...overrides
  };
}

const compactExecution: NonNullable<Turn['execution']> = {
  providerId: 'echo', accountId: 'echo', model: null, effort: null, speed: null,
  permissionMode: 'default', sessionId: 'session', sessionGeneration: 0,
  selectionVersion: 0, operation: 'compact', automatic: true,
};

function text(testid: string): string | null {
  return document.querySelector(`[data-testid=${testid}]`)?.textContent ?? null;
}

test('a silent running turn reports work without implying an answer is being written', () => {
  const message = { id: 'prompt', role: 'user', turnId: 'turn-1', parts: [{ type: 'text', text: 'Check the files' }] } as Message;
  running = mount(MessageTurnSummary, { target: document.body, props: {
    store: { connection: 'ready', openThread: { id: 't-1', status: 'running', turns: [] } } as unknown as Store,
    threadId: 't-1', turn: turn({ status: 'running', finishedAt: null, usage: null }), message, messages: [message],
  } });
  flushSync();
  expect(document.querySelector('[data-testid=typing-indicator]')).toBeNull();
  expect(text('turn-elapsed')).toMatch(/^Working for /);
  expect(document.querySelector('[data-testid=turn-summary] .spinner')).not.toBeNull();
});

test('a finished turn reads how long it worked, when it was done and what it spent', () => {
  running = mount(TurnSummary, { target: document.body, props: { turn: turn() } });
  flushSync();
  expect(text('turn-elapsed')).toBe('Worked for 4m 41s');
  expect(text('turn-finished-at')).toBe(`done ${clockTime(STARTED + 281_000)}`);
  expect(text('turn-tokens')).toContain('tokens');
  expect(document.querySelector('[data-testid=turn-background]')).toBeNull();
});

test('a turn that carries on after monitoring counts from the user request, its own share on hover', () => {
  // The user's turn began 30 minutes before Boite woke the agent for this one.
  const request = STARTED - 1_800_000;
  running = mount(TurnSummary, { target: document.body, props: { turn: turn(), requestStartedAt: request } });
  flushSync();
  const shown = document.querySelector('[data-testid=turn-elapsed]');
  expect(shown?.textContent).toBe('Worked for 34m 41s');
  expect(shown?.getAttribute('title')).toBe('This reply alone: 4m 41s');
});

test('a request start after the turn began, from a clock skew, falls back to the turn', () => {
  running = mount(TurnSummary, { target: document.body, props: { turn: turn(), requestStartedAt: STARTED + 60_000 } });
  flushSync();
  expect(text('turn-elapsed')).toBe('Worked for 4m 41s');
  expect(document.querySelector('[data-testid=turn-elapsed]')?.getAttribute('title')).toBeNull();
});

test('a compaction keeps its own duration whatever request it follows', () => {
  running = mount(TurnSummary, { target: document.body, props: { turn: turn({ execution: compactExecution }), requestStartedAt: STARTED - 1_800_000 } });
  flushSync();
  expect(text('turn-elapsed')).toBe('Compacted in 4m 41s');
  expect(document.querySelector('[data-testid=turn-elapsed]')?.getAttribute('title')).toBeNull();
});

test.each([
  ['a finished turn', {}, [], true],
  ['a stopped turn', { status: 'stopped' }, [], true],
  ['a failed turn', { status: 'error' }, [], false],
  ['a running turn', { status: 'running', finishedAt: null, usage: null }, [], false],
  ['a finished turn with work left running', {}, [{ id: 'bash-1', kind: 'shell', description: 'bun run dev', toolId: 'tool-1', startedAt: STARTED }], false],
] as const)('%s waits for the pointer only when nothing in it needs attention', (_name, overrides, background, settled) => {
  running = mount(TurnSummary, { target: document.body, props: { turn: turn(overrides as Partial<Turn>), background: [...background] as BackgroundTask[] } });
  flushSync();
  expect(document.querySelector('[data-testid=turn-summary]')?.classList.contains('settled')).toBe(settled);
});

test('work left in the background is counted by kind and can be stopped', () => {
  const tasks: BackgroundTask[] = [
    { id: 'bash-1', kind: 'shell', description: 'bun run dev:ui', toolId: 'tool-1', startedAt: STARTED },
    { id: 'bash-2', kind: 'shell', description: 'bun run dev:core', toolId: 'tool-2', startedAt: STARTED },
    { id: 'agent-1', kind: 'agent', description: 'review', toolId: 'tool-3', startedAt: STARTED }
  ];
  let stopped = 0;
  running = mount(TurnSummary, { target: document.body, props: { turn: turn(), background: tasks, stop: () => { stopped += 1; } } });
  flushSync();
  expect(text('turn-background')).toBe('2 shells, 1 agent still running');
  document.querySelector<HTMLButtonElement>('[data-testid=turn-background-stop]')!.click();
  expect(stopped).toBe(1);
});

test('a running turn shows no finish time and no stop for its background work', () => {
  const tasks: BackgroundTask[] = [{ id: 'bash-1', kind: 'shell', description: 'sleep 30', toolId: 'tool-1', startedAt: STARTED }];
  running = mount(TurnSummary, {
    target: document.body,
    props: { turn: turn({ status: 'running', finishedAt: null, usage: null }), activeTool: true, background: tasks, stop: () => {} }
  });
  flushSync();
  expect(text('turn-elapsed')).toMatch(/^Working for /);
  expect(document.querySelector('[data-testid=turn-finished-at]')).toBeNull();
  expect(document.querySelector('[data-testid=turn-tokens]')).toBeNull();
  expect(text('turn-background')).toBe('1 shell still running');
  expect(document.querySelector('[data-testid=turn-background-stop]')).toBeNull();
});

test('a silent running phase shows the last real activity age without a trace action', () => {
  const now = Date.now();
  running = mount(TurnSummary, { target: document.body, props: {
    turn: turn({ status: 'running', startedAt: now - 120_000, finishedAt: null, usage: null }),
    progress: { turnId: 'turn-1', phase: 'retrying', detail: '2/5', at: now - 75_000 },
    activeTool: true,
  } });
  flushSync();
  expect(text('turn-progress')).toBe('Retrying request: 2/5');
  expect(text('turn-last-activity')).toBe('No new activity for 1m 15s');
  expect(document.querySelector('[data-testid=turn-summary] button')).toBeNull();
});

test.each(['old-turn', null])('an older turn or old core (%s) supplies no inferred activity', id => {
  running = mount(TurnSummary, { target: document.body, props: {
    turn: turn({ status: 'running', finishedAt: null }),
    progress: id ? { turnId: id, phase: 'compacting', detail: 'old', at: STARTED } : undefined
  } });
  flushSync();
  expect(document.querySelector('[data-testid=turn-progress]')).toBeNull();
  expect(document.querySelector('[data-testid=turn-last-activity]')).toBeNull();
});

test('a finished turn ignores retained provider progress', () => {
  running = mount(TurnSummary, { target: document.body, props: {
    turn: turn(), progress: { turnId: 'turn-1', phase: 'tool', detail: 'Bash', at: STARTED }
  } });
  flushSync();
  expect(document.querySelector('[data-testid=turn-progress]')).toBeNull();
  expect(text('turn-elapsed')).toBe('Worked for 4m 41s');
});

test('provider signals do not imply new execution progress or text', () => {
  const now = Date.now();
  running = mount(TurnSummary, { target: document.body, props: {
    turn: turn({ status: 'running', startedAt: now - 120_000, finishedAt: null, usage: null }),
    progress: { turnId: 'turn-1', phase: 'waiting', detail: null, at: now - 75_000, providerAt: now },
  } });
  flushSync();
  expect(text('turn-progress')).toBe('Waiting for provider');
  expect(text('turn-last-activity')).toBe('No new activity for 1m 15s');
  expect(text('turn-provider-signal')).toBe('Provider signal 0s ago');
});

test('a compaction turn identifies maintenance even before provider progress arrives', () => {
  vi.useFakeTimers({ now: STARTED + 9_000 });
  running = mount(TurnSummary, { target: document.body, props: {
    turn: turn({ status: 'running', finishedAt: null, usage: null, execution: compactExecution }), activeTool: true,
  } });
  flushSync();
  const summary = document.querySelector('[data-testid=turn-summary]');
  expect(summary?.getAttribute('aria-label')).toBe('Compacting conversation');
  expect(text('compaction-elapsed')).toBe('Elapsed: 9s');
  expect(document.querySelector('[data-testid=typing-indicator]')).toBeNull();
  expect(document.querySelector('[data-testid=turn-elapsed]')).toBeNull();
  expect(document.querySelector('[role=progressbar]')).toBeNull();
  vi.advanceTimersByTime(2_000);
  flushSync();
  expect(text('compaction-elapsed')).toBe('Elapsed: 11s');
});

test('mid-turn compaction hides reply activity without labelling the whole turn as compaction time', () => {
  running = mount(TurnSummary, { target: document.body, props: {
    turn: turn({ status: 'running', finishedAt: null }),
    progress: { turnId: 'turn-1', phase: 'compacting', detail: null, at: Date.now(), providerAt: Date.now() + 1 },
  } });
  flushSync();
  expect(document.querySelector('[data-testid=turn-summary]')?.getAttribute('aria-label')).toBe('Compacting conversation');
  expect(document.querySelector('[data-testid=typing-indicator]')).toBeNull();
  expect(document.querySelector('[data-testid=compaction-elapsed]')).toBeNull();
  expect(document.querySelector('[data-testid=turn-last-activity]')).toBeNull();
  expect(document.querySelector('[data-testid=turn-provider-signal]')).toBeNull();
});

test.each([
  ['done', 'Context compacted', 'Compacted in 4m 41s'],
  ['error', 'Compaction failed', 'Elapsed: 4m 41s'],
  ['stopped', 'Compaction stopped', 'Elapsed: 4m 41s'],
] as const)('a %s compaction reports its outcome without calling it work', (status, label, elapsed) => {
  running = mount(TurnSummary, { target: document.body, props: {turn:turn({status,execution:compactExecution})} });
  flushSync();
  expect(document.querySelector('[data-testid=turn-summary]')?.getAttribute('aria-label')).toBe(label);
  expect(text('turn-elapsed')).toBe(elapsed);
  if (status !== 'done') expect(text('compaction-result')).toBe(label);
});
