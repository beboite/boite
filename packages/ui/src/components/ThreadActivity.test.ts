import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { QuestionRequest, Thread, ThreadActivity } from '@boite/contracts';
import { Store } from '../lib/store.svelte';
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

test('a blocked goal asks for an answer and its reply button focuses the composer', () => {
  const box = document.createElement('textarea');
  box.dataset.testid = 'composer-input';
  render({ goal: { objective: 'Migrate', status: 'paused', iterations: 1, error: 'The agent reported a blocker. Reply to resume.', blocked: true }, loop: null, tasks: [] });
  document.body.append(box);
  const row = document.querySelector('[data-testid=activity-goal]')!;
  expect(row.getAttribute('data-blocked')).toBe('true');
  expect(row.textContent).toContain('Needs your answer');
  expect(document.querySelector('.error')).toBeNull();
  const hint = document.querySelector('[data-testid=activity-goal-blocked]')!;
  expect(hint.textContent).toContain('Your next message resumes the goal');
  hint.querySelector('button')!.click();
  expect(document.activeElement).toBe(box);
});
