import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { QuestionRequest, Thread, ThreadActivity, ThreadSummary } from '@boite/contracts';
import { Store } from '../lib/store.svelte';
import { replyTarget } from '../lib/question-reply.svelte';
import ThreadActivityView from './ThreadActivity.svelte';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.innerHTML = '';
});
function render(activity: ThreadActivity) {
  const store = new Store();
  store.connection = 'ready';
  store.openThread = { id: 'thread', activity } as Thread;
  view = mount(ThreadActivityView, { target: document.body, props: { store } });
  flushSync();
  return store;
}
const tasks = () => [
  { id: 'one', text: 'Inspect the parser', status: 'completed' as const },
  { id: 'two', text: 'Check the result', status: 'in_progress' as const }
];
function toggle() { return document.querySelector<HTMLButtonElement>('[data-testid=activity-tasks-toggle]')!; }

test('hover keeps tasks collapsed and only explicit disclosure opens them', () => {
  render({ goal: null, loop: null, tasks: tasks() });
  document.querySelector('section')!.dispatchEvent(new Event('pointerenter'));
  flushSync();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('progress')!.value).toBe(1);
  expect(toggle().textContent).toContain('Check the result');
  toggle().click();
  flushSync();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  toggle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
});

test('completed goal is shown once, then dismissed tasks return when the agent adds work', () => {
  const store = render({ goal: { objective: 'Fix the parser', status: 'complete', iterations: 2, error: null }, loop: null, tasks: tasks().map(task => ({ ...task, status: 'completed' })) });
  expect(document.body.textContent!.match(/Fix the parser/g)).toHaveLength(1);
  expect(document.querySelector('[aria-label=Resume]')).toBeNull();
  flushSync(() => { store.openThread!.activity!.goal!.dismissed = true; store.openThread!.activity!.tasksDismissed = true; });
  expect(document.querySelector('section')!.classList.contains('hidden')).toBe(true);
  flushSync(() => { store.openThread!.activity!.tasksDismissed = false; store.openThread!.activity!.tasks = tasks(); });
  expect(document.querySelector('section')!.classList.contains('hidden')).toBe(false);
  expect(toggle().textContent).toContain('Check the result');
});

test('loop presents iteration progress and recent results without repeating its prompt or inventing a cadence', () => {
  render({ goal: null, tasks: [], loop: { prompt: 'Say pong', intervalMs: 0, maxIterations: 2, status: 'complete', iterations: 2, nextRunAt: null, error: null, history: [
    { iteration: 1, turnId: 'a', status: 'done', summary: 'First pong', startedAt: 1, finishedAt: 2 },
    { iteration: 2, turnId: 'b', status: 'done', summary: 'Second pong', startedAt: 3, finishedAt: 4 }
  ] } });
  expect(document.body.textContent).toContain('Iteration 2 of 2');
  expect(document.body.textContent).not.toContain('Say pong');
  expect(document.body.textContent).not.toContain('Every');
  toggle().click();
  flushSync();
  const entries = [...document.querySelectorAll('.history li')].map(el => el.textContent);
  expect(entries[0]).toContain('Second pong');
  expect(entries[1]).toContain('First pong');
});

test('pause targets the owning store and disabled control prevents duplicate requests', async () => {
  const store = render({ goal: { objective: 'Fix parser', status: 'active', iterations: 1, error: null }, loop: null, tasks: [] });
  const call = vi.fn().mockResolvedValue({ ...store.openThread!.activity, goal: { ...store.openThread!.activity!.goal, status: 'paused' } });
  vi.spyOn(store, 'client', 'get').mockReturnValue({ call } as unknown as Store['client']);
  const pause = document.querySelector<HTMLButtonElement>('[aria-label=Pause]')!;
  pause.click();
  flushSync();
  expect(pause.disabled).toBe(true);
  pause.click();
  expect(call).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  flushSync();
  expect(call).toHaveBeenCalledWith('threads.activity.control', { threadId: 'thread', kind: 'goal', action: 'pause' });
  await vi.waitFor(() => expect(document.querySelector('[aria-label=Resume]')).not.toBeNull());
});

test('another thread\'s question comes up open over one folded here, as many questions as before', () => {
  const question = (id: string, threadId: string): QuestionRequest => ({
    id, threadId, turnId: 'turn', text: `Which way for ${threadId}?`, options: [], allowText: true, multiple: false, async: true, createdAt: 1
  });
  const store = render({ goal: null, loop: null, tasks: [] });
  flushSync(() => { store.pendingQuestions = [question('first', 'thread'), question('second', 'other')]; });
  expect(document.querySelector('section')!.classList.contains('inline')).toBe(true);
  expect(document.querySelector('[data-testid=composer-reply]')!.getAttribute('data-question')).toBe('first');
  expect(document.querySelector('[data-testid=question-reply-hint], [data-testid=question-submit]')).toBeNull();
  const fold = () => document.querySelector<HTMLButtonElement>('[data-testid=activity-question-toggle]')!;
  fold().click();
  flushSync();
  expect(fold().getAttribute('aria-expanded')).toBe('false');
  flushSync(() => { store.openThread = { id: 'other', activity: { goal: null, loop: null, tasks: [] } } as unknown as Thread; });
  expect(fold().getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('[data-testid=activity-question]:not([hidden])')!.getAttribute('data-question')).toBe('second');
});

test('a sub-agent\'s questions and permission wait in its parent\'s dock, named, opened, never answered by the parent\'s composer', () => {
  const question = (id: string, threadId: string, async: boolean): QuestionRequest => ({
    id, threadId, turnId: 'turn', text: `Which way for ${id}?`, options: [{ id: 'a', label: 'A' }], allowText: true, multiple: false, ...(async ? { async: true } : {}), createdAt: 1
  });
  const store = render({ goal: null, loop: null, tasks: [] });
  const open = vi.spyOn(store, 'open').mockResolvedValue(undefined as never);
  const row = (id: string, title: string, parentThreadId: string | null, archived = false) => ({ id, title, parentThreadId, archived, status: 'running' }) as ThreadSummary;
  flushSync(() => {
    store.threads = [row('thread', 'Parent', null), row('child', 'Migrate the keys', 'thread'), row('gone', 'Archived child', 'thread', true), row('stranger', 'Elsewhere', null)];
    // Its own question without stopping, a child's of both kinds, and questions no child of this thread asked.
    store.pendingQuestions = [question('own', 'thread', true), question('child-async', 'child', true), question('child-stop', 'child', false), question('archived', 'gone', true), question('stranger', 'stranger', true)];
    store.pendingPermissions = [{ id: 'perm', threadId: 'child', turnId: 'turn', toolName: 'Bash', input: { command: 'bun run migrate' }, description: 'Run it', createdAt: 2 }];
  });
  const docked = () => [...document.querySelectorAll<HTMLElement>('[data-testid=activity-question]')];
  expect(docked().map(card => card.dataset['question'])).toEqual(['own', 'child-async', 'child-stop']);
  expect(document.querySelector('[data-testid=activity-question-index]')!.textContent).toBe('3 of 3');
  const shown = () => document.querySelector<HTMLElement>('[data-testid=activity-question]:not([hidden])')!;
  // The newest is up: a child's, with whose it is and the way into it, and no hand-off to this composer.
  expect(shown().dataset['question']).toBe('child-stop');
  expect(shown().querySelector('[data-testid=activity-subagent-question]')!.textContent).toContain('Asked by Migrate the keys');
  expect(shown().querySelector('[data-testid=question-write]')).toBeNull();
  expect(document.querySelector('[data-testid=composer-reply]')).toBeNull();
  expect(replyTarget(store)).toBeNull();
  shown().querySelector<HTMLButtonElement>('[data-testid=activity-open-subagent]')!.click();
  expect(open).toHaveBeenCalledWith('child');
  // Back on its own question, the composer answers that one again.
  document.querySelector<HTMLButtonElement>('[data-testid=activity-question-next]')!.click();
  flushSync();
  expect(shown().dataset['question']).toBe('own');
  expect(shown().querySelector('[data-testid=activity-subagent-question]')).toBeNull();
  expect(replyTarget(store)?.id).toBe('own');

  const wait = document.querySelector<HTMLElement>('[data-testid=activity-subagent-permission]')!;
  expect(wait.dataset['thread']).toBe('child');
  expect(wait.textContent).toContain('Migrate the keys waits for your permission');
  expect(wait.textContent).toContain('Run a command');
  wait.querySelector<HTMLButtonElement>('[data-testid=activity-open-subagent]')!.click();
  expect(open).toHaveBeenLastCalledWith('child');
});

test('a blocked goal asks for an answer and its reply button focuses the composer', () => {
  const box = document.createElement('textarea');
  box.dataset.testid = 'composer-input';
  render({ goal: { objective: 'Migrate', status: 'paused', iterations: 1, error: 'The agent reported a blocker. Reply to resume.', blocked: true }, loop: null, tasks: [] });
  document.body.append(box);
  const row = document.querySelector('[data-testid=activity-goal]')!;
  expect(row.getAttribute('data-blocked')).toBe('true');
    expect(document.querySelector('.error')).toBeNull();
  const hint = document.querySelector('[data-testid=activity-goal-blocked]')!;
  expect(hint.textContent).toContain('Waiting for your answer');
  expect(hint.textContent).toContain('Your next message resumes the goal');
  hint.querySelector('button')!.click();
  expect(document.activeElement).toBe(box);
});

test('a reviewed goal shows one dot per verdict, the running review, and opens a reviewer conversation', () => {
  const store = render({ tasks: [], loop: null, goal: { objective: 'Fix the parser', status: 'active', iterations: 2, error: null, review: {
    phase: 'reviewing', maxRounds: 5, reviewerThreadId: 'reviewer-2', claimTurnId: 'turn-2', delivered: 1,
    verdicts: [{ round: 1, verdict: 'fail', summary: '- The parser test fails', threadId: 'reviewer-1', finishedAt: 1 }]
  } } });
  const open = vi.spyOn(store, 'open').mockResolvedValue(undefined as never);
  const goal = document.querySelector('[data-testid=activity-goal]')!;
  expect(goal.textContent).toContain('Reviewed goal');
  expect(goal.textContent).toContain('Reviewing');
  const dots = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=activity-goal-reviews] .verdict')];
  expect(dots.map(dot => dot.dataset.verdict)).toEqual(['fail', 'running']);
  expect(dots[0]!.title).toBe('Review 1: Fail');
  expect(document.querySelector('[data-testid=activity-goal-reviews]')!.textContent).toContain('Review 2 in progress');
  dots[0]!.click();
  dots[1]!.click();
  expect(open.mock.calls.map(call => call[0])).toEqual(['reviewer-1', 'reviewer-2']);
  toggle().click();
  flushSync();
  expect(toggle().textContent).toContain('Reviews');
  expect(document.querySelector('[data-testid=activity-reviews]')!.textContent).toContain('- The parser test fails');
});

test('a reviewed goal past its five reviews counts the extra round in the total', () => {
  const verdicts = Array.from({ length: 6 }, (_, i) => ({ round: i + 1, verdict: 'partial' as const, summary: '', threadId: `reviewer-${i + 1}`, finishedAt: i }));
  render({ tasks: [], loop: null, goal: { objective: 'Fix it', status: 'paused', blocked: true, iterations: 6, error: null, review: { phase: 'working', maxRounds: 5, reviewerThreadId: null, claimTurnId: null, delivered: 5, verdicts } } });
  expect(document.querySelector('[data-testid=activity-goal-reviews]')!.textContent).toContain('Review 6 of 6 · Partial');
});
