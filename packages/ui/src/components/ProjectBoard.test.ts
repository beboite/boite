import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import DrawerTabs from './DrawerTabs.svelte';
import ProjectBoard from './ProjectBoard.svelte';

afterEach(() => {
  localStorage.removeItem('boite:drawer-tab');
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await tick();
  }
  flushSync();
}

async function ready(options: ConstructorParameters<typeof FakeClient>[0] = {}): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0, boardDemo: true, ...options });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  return { store, client };
}

function texts(column: string): string[] {
  return [...document.querySelectorAll(`[data-column=${column}] [data-testid=board-card-text]`)].map(node => node.textContent!.trim());
}

function card(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-testid=board-card]')].find(node => node.querySelector('[data-testid=board-card-text]')!.textContent!.trim() === text);
  if (!found) throw new Error(`no card ${text}`);
  return found;
}

async function pick(text: string, id: string): Promise<void> {
  card(text).querySelector<HTMLButtonElement>('[data-testid=board-card-menu]')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>(`[data-value="${id}"]`)!.click();
  await settle();
}

test('the board puts each card in its column, starts a /goal2 for a card put in progress and moves the rest by menu or drop', async () => {
  const { store, client } = await ready();
  const component = mount(ProjectBoard, { target: document.body, props: { store, threadId: 't-trace', narrow: false } });
  try {
    await settle();
    expect(texts('todo')).toEqual(['Give the file tree its rows', 'Export invoices as CSV', 'Keyboard shortcut to open the panel']);
    expect(texts('doing')).toEqual(['Dark theme for the settings page']);
    expect(texts('review')).toEqual(['Ship the changes surface', 'Phone chat scroll']);
    expect(texts('done')).toEqual(['Move the trace behind the panel toggle']);
    const dark = card('Dark theme for the settings page');
    expect(dark.querySelector('[data-testid=board-card-progress]')!.textContent).toContain('2/5');
    expect(dark.querySelector('[data-testid=board-card-agent]')!.textContent).toContain('claude-opus-5-5');
    expect(card('Phone chat scroll').querySelector('[data-testid=board-card-state]')!.textContent).toBe('Under review');
    expect(card('Ship the changes surface').querySelector('[data-testid=board-card-state]')!.textContent).toBe('Awaiting you');
    // The checklist unfolds under the card's text.
    dark.querySelector<HTMLButtonElement>('[data-testid=board-card-text]')!.click();
    await settle();
    expect(dark.querySelectorAll('[data-testid=goal-checklist-item]')).toHaveLength(5);

    // In progress: a new conversation of the project works on the card as a reviewed goal, and the card links it.
    const before = new Set(store.threads.map(thread => thread.id));
    const calls = vi.spyOn(client, 'call');
    await pick('Export invoices as CSV', 'move:doing');
    await settle();
    // The fake agent claims at once, so its goal may already be under review.
    expect(texts('todo')).not.toContain('Export invoices as CSV');
    expect([...texts('doing'), ...texts('review')]).toContain('Export invoices as CSV');
    const started = store.threads.find(thread => !before.has(thread.id))!;
    // Named after the card when created. Its first turn then has it retitled (`Echo: /goal2 ...` here, 200 ms
    // later in the fake), which a slow runner reached before this line.
    expect(calls.mock.calls.find(([method]) => method === 'threads.create')?.[1]).toMatchObject({ projectId: 'p-boite', title: 'Export invoices as CSV' });
    expect(started.projectId).toBe('p-boite');
    const [linked] = (await client.call('todos.list', { threadId: 't-trace' })).filter(todo => todo.text === 'Export invoices as CSV');
    expect(linked!.goalThreadId).toBe(started.id);
    const goal = (await client.call('threads.get', { threadId: started.id })).activity?.goal;
    expect(goal).toMatchObject({ objective: 'Export invoices as CSV', review: { maxRounds: 5 } });

    // In review by the menu, then Done: the user's confirmation.
    await pick('Keyboard shortcut to open the panel', 'move:review');
    expect(texts('review')).toContain('Keyboard shortcut to open the panel');
    await pick('Ship the changes surface', 'move:done');
    expect(texts('done')).toEqual(['Move the trace behind the panel toggle', 'Ship the changes surface']);

    // Dropped back in To do, a card lets go of its conversation, which goes on by itself.
    const drag = new Event('dragstart', { bubbles: true }) as DragEvent;
    card('Dark theme for the settings page').dispatchEvent(drag);
    const todo = document.querySelector<HTMLElement>('[data-column=todo]')!;
    todo.dispatchEvent(Object.assign(new Event('dragover', { bubbles: true, cancelable: true })));
    flushSync();
    expect(todo.classList.contains('over')).toBe(true);
    todo.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await settle();
    expect(texts('todo')).toContain('Dark theme for the settings page');
    expect((await client.call('todos.list', { threadId: 't-trace' })).find(entry => entry.id === 'board-todo-3')!.goalThreadId).toBeNull();
  } finally {
    unmount(component);
  }
});

test('a start that loses to another device leaves no stray conversation, and a card whose goal stopped starts it again', async () => {
  const { store, client } = await ready();
  const component = mount(ProjectBoard, { target: document.body, props: { store, threadId: 't-trace', narrow: false } });
  try {
    await settle();
    // This device still sees the card unlinked; another one linked it first.
    const stale = { ...(await client.call('todos.list', { threadId: 't-trace' })).find(todo => todo.id === 'board-todo-1')! };
    await client.call('todos.update', { threadId: 't-trace', todoId: 'board-todo-1', goalThreadId: 't-board-scroll' });
    const before = store.threads.map(thread => thread.id).sort();
    expect(await store.startCardGoal('t-trace', stale)).toBeNull();
    await settle();
    expect(store.threads.map(thread => thread.id).sort()).toEqual(before);
    expect(store.error).toContain('already works in conversation t-board-scroll');
    store.error = null;

    // The goal removed from its conversation: the card says so and offers to start it again.
    await client.call('threads.activity.control', { threadId: 't-board-dark', kind: 'goal', action: 'remove' });
    await settle();
    const dark = card('Dark theme for the settings page');
    expect(dark.closest('[data-column]')!.getAttribute('data-column')).toBe('doing');
    expect(dark.querySelector('[data-testid=board-card-state]')!.textContent).toBe('Goal not running');
    await pick('Dark theme for the settings page', 'resume');
    expect((await client.call('threads.get', { threadId: 't-board-dark' })).activity?.goal).toMatchObject({ objective: 'Dark theme for the settings page', review: { maxRounds: 5 } });
    expect(card('Dark theme for the settings page').querySelector('[data-testid=board-card-state]')?.textContent).not.toBe('Goal not running');
  } finally {
    unmount(component);
  }
});

test('a phone swipes the board one column a screen, a dot per column, and reaches it from a paired device', async () => {
  const { store } = await ready({ principal: 'session' });
  expect(store.owner).toBe(false);
  // jsdom lays nothing out and has no scrolling: the pager's page follows the dot it was sent to.
  const scrolled: number[] = [];
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) { scrolled.push(typeof options === 'number' ? options : options?.left ?? 0); } as typeof HTMLElement.prototype.scrollTo;
  const component = mount(ProjectBoard, { target: document.body, props: { store, threadId: 't-trace', narrow: true } });
  try {
    await settle();
    expect(document.querySelector('[data-testid=project-board]')!.classList.contains('pager')).toBe(true);
    // No drag under a finger: a card moves by its menu.
    expect(card('Export invoices as CSV').getAttribute('draggable')).toBe('false');
    const dots = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=board-page]')];
    expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual(['To do, 3', 'In progress, 1', 'In review, 2', 'Done, 1']);
    expect(dots.map(dot => dot.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    dots[2]!.click();
    await settle();
    expect(dots.map(dot => dot.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false']);
    // A device is the user: it confirms a card an agent claimed.
    await pick('Ship the changes surface', 'move:done');
    expect(texts('done')).toContain('Ship the changes surface');
    expect(dots.map(dot => dot.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'true']);
  } finally {
    unmount(component);
  }
});

test('Ctrl+J opens the drawer on the tab picked last; a device without a shell opens the board', async () => {
  const { store } = await ready();
  expect(store.boardAvailable()).toBe(true);
  store.toggleDrawer();
  expect([store.boardShown, store.drawerTab]).toEqual([true, 'board']);
  store.toggleDrawer();
  expect(store.boardShown).toBe(false);
  // The terminal tab: the board steps aside and Ctrl+J comes back to the shell.
  store.showBoard();
  const tabs = mount(DrawerTabs, { target: document.body, props: { store, current: 'board' } });
  try {
    document.querySelector<HTMLButtonElement>('[data-testid=drawer-tab-terminal]')!.click();
    expect([store.boardShown, store.terminalShown('t-trace'), store.drawerTab]).toEqual([false, true, 'terminal']);
    store.toggleDrawer();
    expect(store.terminalShown('t-trace')).toBe(false);
    store.toggleDrawer();
    expect([store.boardShown, store.terminalShown('t-trace')]).toEqual([false, true]);
    store.showBoard();
    expect([store.boardShown, store.terminalShown('t-trace'), store.drawerTab]).toEqual([true, false, 'board']);
  } finally {
    unmount(tabs);
  }

  // A terminal left open in another thread stays put away once the board took the drawer.
  store.hideBoard();
  await store.open('t-board-dark');
  store.toggleTerminal();
  expect(store.terminalShown('t-board-dark')).toBe(true);
  await store.open('t-trace');
  store.showBoard();
  await store.open('t-board-dark');
  expect([store.boardShown, store.terminalShown('t-board-dark')]).toEqual([true, false]);
  await store.open('t-trace');

  // A core that does not link cards to goals has no board: Ctrl+J is the terminal again.
  store.core!.features!.projectBoard = false;
  expect(store.boardAvailable()).toBe(false);
  store.hideBoard();
  store.toggleDrawer();
  expect([store.boardShown, store.terminalShown('t-trace')]).toEqual([false, true]);
  store.core!.features!.projectBoard = true;

  const phone = await ready({ principal: 'session' });
  phone.store.toggleDrawer();
  expect(phone.store.boardShown).toBe(true);
  const phoneTabs = mount(DrawerTabs, { target: document.body, props: { store: phone.store, current: 'board' } });
  try {
    expect(document.querySelectorAll('[data-testid=drawer-tab-terminal]')).toHaveLength(0);
  } finally {
    unmount(phoneTabs);
  }
});
