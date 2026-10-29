import { expect, test } from 'vitest';
import type { Message, MessagePart, Turn } from '@boite/contracts';
import { AgentTimeline, FOLD_PREFIX, TurnFolds, foldText, memoryTurn, quietReason } from './agent-turns';

const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({ id, threadId: 't', status: 'done', queuedAt: 0, startedAt: 0, finishedAt: 180_000, usage: null, error: null, ...extra });
const message = (id: string, turnId: string, role: Message['role'], parts: MessagePart[], createdAt = 0): Message => ({ id, threadId: 't', turnId, role, state: 'complete', createdAt, parts });
const text = (value: string): MessagePart => ({ type: 'text', text: value });
const call = (id: string): MessagePart => ({ type: 'tool', toolId: id, name: 'Bash', input: { command: 'ls' }, output: '', status: 'done' });
const routine = (id: string, extra: Partial<Turn> = {}) => turn(id, { execution: { operation: 'routine' } as Turn['execution'], ...extra });

test('a quiet wake reads its reason from a [quiet] line opening or closing its final text block, and only a settled routine or event turn can be quiet', () => {
  const answer = (value: string) => [message('a', 'r', 'assistant', [call('x'), text('Checked.'), text(value)])];
  expect(quietReason(routine('r'), answer('All good.\n\n[quiet] 4 issues, nothing new'))).toBe('4 issues, nothing new');
  expect(quietReason(routine('r'), answer('[QUIET] inbox empty\nNothing to do.'))).toBe('inbox empty');
  // The marker counts only in the final text block of the final answer.
  expect(quietReason(routine('r'), [message('a', 'r', 'assistant', [text('[quiet] early'), call('x'), text('Here is what needs you.')])])).toBeNull();
  // The core may have marked it without a reason the client can read.
  expect(quietReason(routine('r', { quiet: true }), answer('Done.'))).toBe('');
  expect(quietReason(turn('u'), answer('[quiet] a user turn is never quiet'))).toBeNull();
  expect(quietReason(routine('r', { status: 'running', finishedAt: null }), answer('[quiet] not yet'))).toBeNull();
  // A wake that failed or was stopped after writing its marker is not "Nothing to report": its error stays in view.
  const failed = [message('a', 'r', 'assistant', [text('[quiet] checked'), { type: 'error', message: 'provider failed' }])];
  expect(quietReason(routine('r', { status: 'error' }), failed)).toBeNull();
  expect(quietReason(routine('r', { status: 'stopped' }), failed)).toBeNull();
  expect(new TurnFolds().build(failed, [routine('r', { status: 'error' })], new Set())).toBe(failed);
});

test('a finished agent turn folds its calls and narration away, counted for the line under its answer; a running turn and an opened one keep every step', () => {
  const folds = new TurnFolds();
  const prompt = message('u1', 'w', 'user', [text('Fix it')], 1);
  const work = message('a1', 'w', 'assistant', [{ type: 'thinking', text: 'plan' }, text('Reading first.'), call('c1'), call('c2'), text('Fixed: the redirect now lands home.'), { type: 'error', message: 'one warning' }], 2);
  const timeline = [prompt, work];

  const folded = folds.build(timeline, [turn('w')], new Set());
  // No row of its own: the summary line under the answer carries the count.
  expect(folded.map(m => m.id)).toEqual(['u1', 'a1']);
  // The answer and what is not a step (an error) stay; the reasoning, the calls and the narration before them leave.
  expect(folded[1]!.parts).toEqual([text('Fixed: the redirect now lands home.'), { type: 'error', message: 'one warning' }]);
  const fold = folds.folds.get(`${FOLD_PREFIX}w`)!;
  expect(fold).toMatchObject({ kind: 'worked', steps: 2, ms: 180_000, open: false });
  expect(foldText(fold)).toBe('Worked 3 min · 2 steps');
  // Built again on the same data, every row is the same object: nothing is measured again.
  const again = folds.build(timeline, [turn('w')], new Set());
  expect(again[1]).toBe(folded[1]);

  const opened = folds.build(timeline, [turn('w')], new Set(['w']));
  expect(opened.map(m => m.id)).toEqual(['u1', 'a1']);
  expect(opened[1]).toBe(work);
  expect(folds.folds.get(`${FOLD_PREFIX}w`)?.open).toBe(true);

  // While it runs, the steps stay live and nothing folds: the same array comes back.
  expect(folds.build(timeline, [turn('w', { status: 'running', finishedAt: null })], new Set())).toBe(timeline);
  // A turn that called nothing has nothing to fold.
  const chat = [message('u2', 'c', 'user', [text('hi')]), message('a2', 'c', 'assistant', [text('Hello.')])];
  expect(folds.build(chat, [turn('c')], new Set())).toBe(chat);
});

test('a turn split over several answers folds the earlier ones whole and keeps what follows its last call', () => {
  const folds = new TurnFolds();
  const first = message('a1', 'w', 'assistant', [text('Looking.'), call('c1')], 1);
  const second = message('a2', 'w', 'assistant', [call('c2'), text('All three pass.')], 2);
  const folded = folds.build([message('u', 'w', 'user', [text('Check')]), first, second], [turn('w')], new Set());
  expect(folded.map(m => m.id)).toEqual(['u', 'a2']);
  expect(folded[1]!.parts).toEqual([text('All three pass.')]);
});

test('an answer stamped in the same millisecond as the last call still shows under the fold: the timeline order decides', () => {
  const folds = new TurnFolds();
  const work = message('a1', 'w', 'assistant', [call('c1')], 50);
  const answer = message('a2', 'w', 'assistant', [text('The deployment failed. Please sign in.')], 50);
  const folded = folds.build([work, answer], [turn('w')], new Set());
  expect(folded.map(m => m.id)).toEqual(['a2']);
  expect(folded[0]!.parts).toEqual([text('The deployment failed. Please sign in.')]);
});

test('a quiet wake folds whole, its opening line included, to one "Nothing to report" row that opens the turn again', () => {
  const folds = new TurnFolds();
  const wake = message('w1', 'r', 'user', [{ type: 'text', text: 'Check the issues.', displayText: 'Routine · Evening review' }], 1);
  const answer = message('a1', 'r', 'assistant', [call('c1'), call('c2'), text('Nothing new.\n\n[quiet] 4 issues, 2 pull requests')], 2);
  const after = message('u2', 'n', 'user', [text('Thanks')], 3);
  const timeline = [wake, answer, after];

  const folded = folds.build(timeline, [routine('r', { quiet: true })], new Set());
  expect(folded.map(m => m.id)).toEqual([`${FOLD_PREFIX}r`, 'u2']);
  const fold = folds.folds.get(`${FOLD_PREFIX}r`)!;
  expect(fold.kind).toBe('quiet');
  expect(foldText(fold)).toBe('Nothing to report · 4 issues, 2 pull requests · 2 steps');

  const opened = folds.build(timeline, [routine('r', { quiet: true })], new Set(['r']));
  expect(opened.map(m => m.id)).toEqual([`${FOLD_PREFIX}r`, 'w1', 'a1', 'u2']);
  expect(opened[1]).toBe(wake);
  expect(opened[2]).toBe(answer);
});

test('a memory pass marks the last answer the user saw before it, never a quiet wake', () => {
  const turns = [turn('a', { finishedAt: 100 }), turn('b', { finishedAt: 200 }), routine('q', { finishedAt: 250, quiet: true }), turn('c', { finishedAt: 400 })];
  expect(memoryTurn(turns, { at: 300 })).toBe('b');
  expect(memoryTurn(turns, { at: 50 })).toBeNull();
  const agentTimeline = new AgentTimeline();
  const timeline = [message('ua', 'a', 'user', [text('1')]), message('aa', 'a', 'assistant', [text('one')]), message('ub', 'b', 'user', [text('2')]), message('ab', 'b', 'assistant', [text('two')]), message('uc', 'c', 'user', [text('3')])];
  const pass = { threadId: 'mem', status: 'done' as const, summary: 'Noted the second answer.', at: 300 };
  // The timeline gains no row: the turn's summary line carries the mark.
  const shaped = agentTimeline.build(timeline, turns, pass);
  expect(shaped.timeline).toBe(timeline);
  expect(shaped.memoryTurnId).toBe('b');
  expect(agentTimeline.build(timeline, turns, null).memoryTurnId).toBeNull();
  // Not an agent's thread: nothing is shaped.
  expect(agentTimeline.build(timeline, turns, undefined)).toMatchObject({ timeline, memoryTurnId: null });
});
