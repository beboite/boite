import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BackgroundTask, Turn } from '@boite/contracts';
import TurnSummary from './TurnSummary.svelte';
import { clockTime } from '../lib/format';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
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

function text(testid: string): string | null {
  return document.querySelector(`[data-testid=${testid}]`)?.textContent ?? null;
}

test('a finished turn reads how long it worked, when it was done and what it spent', () => {
  running = mount(TurnSummary, { target: document.body, props: { turn: turn() } });
  flushSync();
  expect(text('turn-elapsed')).toBe('Worked for 4m 41s');
  expect(text('turn-finished-at')).toBe(`done ${clockTime(STARTED + 281_000)}`);
  expect(text('turn-tokens')).toContain('tokens');
  expect(document.querySelector('[data-testid=turn-background]')).toBeNull();
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
    props: { turn: turn({ status: 'running', finishedAt: null, usage: null }), background: tasks, stop: () => {} }
  });
  flushSync();
  expect(text('turn-elapsed')).toMatch(/^Working for /);
  expect(document.querySelector('[data-testid=turn-finished-at]')).toBeNull();
  expect(document.querySelector('[data-testid=turn-tokens]')).toBeNull();
  expect(text('turn-background')).toBe('1 shell still running');
  expect(document.querySelector('[data-testid=turn-background-stop]')).toBeNull();
});
