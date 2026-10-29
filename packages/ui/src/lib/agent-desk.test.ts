import { expect, test } from 'vitest';
import type { AgentWatch } from '@boite/contracts';
import { budgetMeter, deskOrder, deskState, deskTone } from './agent-desk';

const watch = (threadId: string, extra: Partial<AgentWatch> = {}): AgentWatch => ({
  agentId: 'a', threadId, title: threadId, projectId: null, origin: 'started', since: 0, state: 'idle', stalledSince: null, lastActivityAt: 0, pullRequest: null, question: null, ...extra,
});
const pr = (state: 'open' | 'merged' | 'closed', checks: 'pending' | 'passing' | 'failing' | null = null) => ({ number: 1, url: 'https://example.test/pull/1', state, checks });

test('a desk card says first what needs the user, then a silent turn, a failure, work under way, then its pull request and how it rests', () => {
  expect(deskState(watch('q', { state: 'needs-you', stalledSince: 5, pullRequest: pr('open', 'failing') }))).toBe('needs-you');
  expect(deskState(watch('s', { state: 'working', stalledSince: 5 }))).toBe('stalled');
  // A stall belongs to a running turn: one left over on a settled thread says nothing.
  expect(deskState(watch('s2', { state: 'idle', stalledSince: 5 }))).toBe('idle');
  expect(deskState(watch('f', { state: 'failed', pullRequest: pr('open') }))).toBe('failed');
  expect(deskState(watch('w', { state: 'working', pullRequest: pr('open', 'pending') }))).toBe('working');
  expect(deskState(watch('m', { state: 'done', pullRequest: pr('merged') }))).toBe('merged');
  expect(deskState(watch('r', { state: 'idle', pullRequest: pr('open', 'failing') }))).toBe('review');
  expect(deskState(watch('c', { state: 'done', pullRequest: pr('closed') }))).toBe('done');
  expect(deskState(watch('a', { state: 'archived' }))).toBe('archived');
  // Hue says status: yellow for what waits, danger for what broke, success once merged or done, the accent only for work under way.
  expect(['needs-you', 'stalled', 'review'].map(s => deskTone(s as never))).toEqual(['live', 'live', 'live']);
  expect([deskTone('failed'), deskTone('merged'), deskTone('working'), deskTone('done'), deskTone('idle')]).toEqual(['danger', 'success', 'accent', 'success', 'muted']);
});

test('the desk lists what needs the user first and settled threads last, newest first within a state', () => {
  const order = deskOrder([
    watch('done', { state: 'done', lastActivityAt: 90 }),
    watch('old-work', { state: 'working', lastActivityAt: 10 }),
    watch('ask', { state: 'needs-you', lastActivityAt: 1 }),
    watch('new-work', { state: 'working', lastActivityAt: 50 }),
    watch('silent', { state: 'working', stalledSince: 3, lastActivityAt: 3 }),
  ]);
  expect(order.map(w => w.threadId)).toEqual(['ask', 'silent', 'new-work', 'old-work', 'done']);
});

test('the budget meter fills against the daily budget and has nothing to measure without one', () => {
  expect(budgetMeter(1.35, 2)).toEqual({ ratio: 0.675, reached: false });
  expect(budgetMeter(3, 2)).toEqual({ ratio: 1, reached: true });
  expect(budgetMeter(1, null)).toBeNull();
  expect(budgetMeter(1, 0)).toBeNull();
});
