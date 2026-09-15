import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Thread, ThreadActivity } from '@boite/contracts';
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



