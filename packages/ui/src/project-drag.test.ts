import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { store } from './lib/store.svelte';
import { workspace } from './lib/workspace.svelte';
import { writeExperiments } from './lib/experiments';
import { closeTour } from './lib/onboarding.svelte';
import { work } from './lib/work-prefs.svelte';
import { projectView } from './lib/project-view.svelte';
import { PROJECT_HOLD, reorders } from './lib/project-drag.svelte';

/*
 * Reordering whole projects by dragging their headers, over the in-memory
 * fake: pointer events, so it works in the desktop shell where HTML drag and
 * drop never reaches the page. Only the manual order takes it.
 */

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

let running: Record<string, unknown> | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  writeExperiments([]);
  window.localStorage.clear();
  work.load();
  workspace.view = 'projects';
  projectView.order = 'recent';
  projectView.keys = [];
});

async function waitFor(check: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

async function mountOnFake(): Promise<void> {
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.page = 'chat';
  store.composerStates = {};
  store.projectPickerOpen = false;
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));
  workspace.view = 'projects';
  await waitFor(() => document.querySelectorAll('section[data-testid=project]').length === 2);
}

/** A pointer event at a point: jsdom has no PointerEvent. */
function pointer(type: string, x: number, y: number, pointerType = 'mouse'): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerType: { value: pointerType }, pointerId: { value: 1 } });
  return event;
}

/** jsdom lays nothing out: the element under the pointer, and each section's box, are what the test says. */
function under(element: () => Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => element() });
}
function place(section: HTMLElement, top: number): void {
  section.getBoundingClientRect = () => ({ top, bottom: top + 100, left: 0, right: 200, width: 200, height: 100, x: 0, y: top, toJSON: () => ({}) });
}

const order = () => Array.from(document.querySelectorAll<HTMLElement>('section[data-testid=project]')).map((s) => s.dataset['projectId']!);
const section = (id: string) => query(`section[data-project-id="${id}"]`);
const header = (id: string) => query(`section[data-project-id="${id}"] [data-testid=project-row]`);
const dragging = () => document.documentElement.classList.contains('project-dragging');

test('a drop changes the order only away from its own place', () => {
  expect(reorders(['a', 'b', 'c'], 'b', 'a', false)).toBe(true);
  expect(reorders(['a', 'b', 'c'], 'b', 'a', true)).toBe(false);
  expect(reorders(['a', 'b', 'c'], 'b', 'c', false)).toBe(false);
  expect(reorders(['a', 'b', 'c'], 'b', 'c', true)).toBe(true);
  expect(reorders(['a', 'b', 'c'], 'b', 'b', true)).toBe(false);
  expect(reorders(['a', 'b'], 'x', 'a', false)).toBe(false);
});

test('in the recent order a project header does not drag', async () => {
  await mountOnFake();
  const [first, second] = order() as [string, string];
  under(() => section(first));
  header(second).dispatchEvent(pointer('pointerdown', 10, 150));
  window.dispatchEvent(pointer('pointermove', 10, 20));
  expect(dragging()).toBe(false);
  expect(document.querySelector('[data-testid=project-drag-ghost]')).toBeNull();
  window.dispatchEvent(pointer('pointerup', 10, 20));
  expect(order()).toEqual([first, second]);
  expect(projectView.keys).toEqual([]);
});

test('in the manual order a header dragged with the mouse moves its project; a short press and Escape do not', async () => {
  await mountOnFake();
  projectView.order = 'manual';
  const [first, second] = order() as [string, string];
  place(section(first), 0);
  place(section(second), 110);
  let target: Element | null = null;
  under(() => target);

  // A press that does not travel stays a click: the project folds, nothing drags.
  header(second).dispatchEvent(pointer('pointerdown', 10, 150));
  window.dispatchEvent(pointer('pointermove', 12, 151));
  expect(dragging()).toBe(false);
  window.dispatchEvent(pointer('pointerup', 12, 151));
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  header(second).dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);

  // Under the first project's lower half the second stays where it is: no line. Its upper half shows one; Escape drops it.
  header(second).dispatchEvent(pointer('pointerdown', 10, 150));
  target = section(first);
  window.dispatchEvent(pointer('pointermove', 10, 80));
  await waitFor(() => section(second).classList.contains('lifted'));
  expect(dragging()).toBe(true);
  expect(section(first).classList.contains('insert-after')).toBe(false);
  expect(query('[data-testid=project-drag-ghost]').textContent).toContain(section(second).dataset['projectName']);
  window.dispatchEvent(pointer('pointermove', 10, 20));
  await waitFor(() => section(first).classList.contains('insert-before'));
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  await waitFor(() => !section(first).classList.contains('insert-before'));
  window.dispatchEvent(pointer('pointerup', 10, 20));
  expect(order()).toEqual([first, second]);

  // Released over the first project's upper half: the second goes before it, and the click that ends the drag opens nothing.
  header(second).dispatchEvent(pointer('pointerdown', 10, 150));
  window.dispatchEvent(pointer('pointermove', 10, 20));
  await waitFor(() => section(first).classList.contains('insert-before'));
  window.dispatchEvent(pointer('pointerup', 10, 20));
  const ending = new MouseEvent('click', { bubbles: true, cancelable: true });
  header(second).dispatchEvent(ending);
  expect(ending.defaultPrevented).toBe(true);
  await waitFor(() => order()[0] === second);
  expect(order()).toEqual([second, first]);
  expect(dragging()).toBe(false);
  expect(document.querySelector('[data-testid=project-drag-ghost]')).toBeNull();
  expect(document.querySelector('.insert-before, .insert-after, .lifted')).toBeNull();
});

test('a finger drags a project header only after holding it still; a finger that travels first scrolls', async () => {
  await mountOnFake();
  projectView.order = 'manual';
  const [first, second] = order() as [string, string];
  place(section(first), 0);
  place(section(second), 110);
  under(() => section(first));

  // Moving before the hold is a scroll: the hold that would have come lifts nothing.
  header(second).dispatchEvent(pointer('pointerdown', 10, 150, 'touch'));
  window.dispatchEvent(pointer('pointermove', 10, 120, 'touch'));
  await new Promise((resolve) => setTimeout(resolve, PROJECT_HOLD + 50));
  expect(dragging()).toBe(false);
  window.dispatchEvent(pointer('pointerup', 10, 120, 'touch'));

  // Held still, the header lifts; its moves no longer scroll the page, and a release over the first project places it there.
  header(second).dispatchEvent(pointer('pointerdown', 10, 150, 'touch'));
  await waitFor(dragging);
  expect(document.querySelector('[data-testid=project-drag-ghost]')).not.toBeNull();
  const touchmove = new Event('touchmove', { bubbles: true, cancelable: true });
  window.dispatchEvent(touchmove);
  expect(touchmove.defaultPrevented).toBe(true);
  window.dispatchEvent(pointer('pointermove', 10, 20, 'touch'));
  await waitFor(() => section(first).classList.contains('insert-before'));
  window.dispatchEvent(pointer('pointerup', 10, 20, 'touch'));
  await waitFor(() => order()[0] === second);
  expect(dragging()).toBe(false);
});
