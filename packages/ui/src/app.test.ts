import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { RpcMethodName } from '@boite/contracts';
import App from './App.svelte';
import { store } from './lib/store.svelte';

// The opener plugin is the shell's system browser; nothing real may run here.
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
  window.localStorage.clear();
  delete window.__TAURI_INTERNALS__;
  openUrl.mockClear();
});

async function waitFor(check: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

/** The model ids the right column of the picker is showing, in order. */
function shownModels(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-model]')).map((el) => el.getAttribute('data-model'));
}

/** The provider ids the rail draws a logo tile for, in order. */
function tiles(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=composer-picker-menu] [data-provider]')).map((el) =>
    el.getAttribute('data-provider')
  );
}

/** The account chips beside the shown provider's name, in order. */
function seats(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-seat]')).map((el) => el.getAttribute('data-instance'));
}

/** The levels the open reasoning slider draws a dot for, in the model's order. */
function effortDots(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=composer-effort-menu] [data-dot]')).map((el) =>
    el.getAttribute('data-dot')
  );
}

/** The prefix labels the model column groups its matches under, in order. */
function groupLabels(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-group]')).map((el) => el.getAttribute('data-group'));
}

/** Type into a field the way a user does, then let the effects settle. */
async function type(field: HTMLInputElement, text: string): Promise<void> {
  field.focus();
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A key on whatever holds the focus, so it walks the same path a real one would. */
function press(key: string): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

async function mountOnFake(): Promise<void> {
  window.history.replaceState(null, '', '/?fake=1');
  const target = document.createElement('div');
  document.body.appendChild(target);
  // The store is a singleton and keeps the previous test's open thread, so
  // `booted` is the only honest signal that this mount finished its own boot.
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.composerStates = {};
  running = mount(App, { target });
  await waitFor(() => store.booted && store.openThread !== null);
}

test('the app mounts against the fake core, lists the seeded threads and opens the latest', async () => {
  await mountOnFake();
  await waitFor(() => store.threads.length === 4);
  await waitFor(() => (document.body.textContent ?? '').includes('Finish the trace tab'));

  const text = document.body.textContent ?? '';
  expect(text).toContain('boite');
  expect(text).toContain('Port the scheduler');
  expect(text).toContain('Connected');
  expect(document.querySelector('[data-testid=composer-input]')).not.toBeNull();
  expect(document.querySelectorAll('[data-testid=thread-row]').length).toBe(4);
  // The most recent thread opens on its own; nothing to click first.
  expect(store.openThread?.id).toBe('t-descriptors');
});

test('New thread opens a draft and the first send creates the thread titled from the prompt', async () => {
  await mountOnFake();

  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  expect(document.querySelector('[data-testid=draft-row]')).not.toBeNull();
  expect(store.openThread).toBeNull();

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Rename the scheduler caps\nand nothing else';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.title).toBe('Rename the scheduler caps');
  expect(store.threads.length).toBe(5);
  await waitFor(() => store.openThread?.messages.length === 2);
  expect(store.openThread?.messages[0]?.role).toBe('user');
});

test('the draft worktree chip puts the first send on its own branch, and the header names it', async () => {
  await mountOnFake();

  // A thread keeps its directory: no chip while one is open.
  expect(document.querySelector('[data-testid=composer-worktree]')).toBeNull();

  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  const chip = query<HTMLButtonElement>('[data-testid=composer-worktree]');
  expect(chip.getAttribute('aria-pressed')).toBe('false');
  chip.click();
  await waitFor(() => store.draft?.worktree === true);
  expect(query<HTMLButtonElement>('[data-testid=composer-worktree]').getAttribute('aria-pressed')).toBe('true');

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Fix the login';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.branch).toBe('boite/fix-the-login');
  expect(store.openThread?.cwd).toBe('D:\\Dev\\.boite-worktrees\\brain\\fix-the-login');
  await waitFor(() => document.querySelector('[data-testid=thread-branch]') !== null);
  expect(query('[data-testid=thread-branch]').textContent?.trim()).toBe('boite/fix-the-login');
  expect(query('[data-testid=thread-branch]').title).toContain('fix-the-login');
  // The chip went with the draft.
  expect(document.querySelector('[data-testid=composer-worktree]')).toBeNull();
});

test('the sidebar draft row hands the keyboard back to the composer', async () => {
  await mountOnFake();

  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  // Something else in the page holds the keyboard, the way it does after a click.
  const gear = query<HTMLButtonElement>('[data-testid=nav-settings]');
  gear.focus();
  expect(document.activeElement).toBe(gear);

  query<HTMLButtonElement>('[data-testid=draft-row]').click();
  await waitFor(
    () => document.activeElement === document.querySelector('[data-testid=composer-input]')
  );
  expect(store.draft).not.toBeNull();

  // The store is the singleton every test shares: the draft goes back out.
  store.draft = null;
});

test('a draft names its project in the heading and the dropdown moves it to another one', async () => {
  await mountOnFake();

  // The one plus left says where it will open the draft, and a project row has none.
  expect(query<HTMLButtonElement>('[data-testid=new-thread]').title).toBe('New thread in brain (Ctrl+N)');
  expect(document.querySelector('[data-testid=project-new-thread]')).toBeNull();

  // The draft opens in the project of the thread that was open, `brain`.
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  const heading = query('[data-testid=draft-empty]');
  expect(heading.textContent).toContain('Start a thread in');
  expect(heading.textContent).toContain('brain');
  // The heading says the project, so the header chip no longer repeats it.
  expect(query('[data-testid=chat] header').textContent).not.toContain('brain');

  query<HTMLButtonElement>('[data-testid=draft-project]').click();
  await waitFor(() => document.querySelector('[data-testid=draft-project-menu]') !== null);
  const rows = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid=draft-project-menu] [data-row]')
  );
  expect(rows.map((row) => row.dataset['value'])).toEqual(['p-boite', 'p-brain']);

  rows[0]?.click();
  await waitFor(() => store.draft?.projectId === 'p-boite');
  await waitFor(() => (query('[data-testid=draft-empty]').textContent ?? '').includes('boite'));
  // The draft row moved with it, and the composer took the keyboard back.
  expect(query('[data-testid=project][data-project-id=p-boite]').querySelector('[data-testid=draft-row]')).not.toBeNull();
  await waitFor(() => document.activeElement === document.querySelector('[data-testid=composer-input]'));

  // The store is the singleton every test shares: the draft goes back out.
  store.draft = null;
});

test('the picker rails the providers as logos and gives the shown one its accounts and models', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  // A draft opens on the first available provider, its default model.
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  // One tile per provider, in the core's order, the one whose files are still to
  // download included: it is picked like any other and its column says why.
  expect(tiles()).toEqual(['claude', 'echo', 'opencode', 'antigravity', 'codex', 'pi', 'grok']);
  // Claude is the shown one and has two logins, so they sit beside its name.
  expect(seats()).toEqual(['claude::a-claude-main', 'claude::a-claude-side']);
  expect(shownModels()).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']);

  // One account: nothing beside the name.
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=echo]').click();
  await waitFor(() => shownModels().length === 1);
  expect(seats()).toEqual([]);

  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=antigravity]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-not-installed]') !== null);
  expect(shownModels()).toEqual([]);

  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=claude]').click();
  await waitFor(() => shownModels().length === 3);
  query<HTMLButtonElement>('[data-testid=picker-legacy]').click();
  await waitFor(() => document.querySelectorAll('[data-model]').length === 7);

  // The second account of the same provider, then a model: one thread with both.
  query<HTMLButtonElement>('[data-instance="claude::a-claude-side"]').click();
  query<HTMLButtonElement>('[data-model="claude-opus-5"]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('Claude Opus 5 · Second seat');

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the second seat';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.accountId).toBe('a-claude-side');
  expect(store.openThread?.model).toBe('claude-opus-5');
});

test('the picker reads an ACP agent models, showing the descriptor and a probing line meanwhile', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=opencode]').click();

  // While the agent is being asked, its descriptor's one model stands.
  await waitFor(() => document.querySelector('[data-testid=picker-probing]') !== null);
  expect(shownModels()).toEqual(['default']);

  await waitFor(() => document.querySelector('[data-testid=picker-probing]') === null);
  // The agent lists more than the column shows at once; the first three are the ones it names first.
  expect(shownModels().length).toBe(23);
  expect(shownModels().slice(0, 3)).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5-codex']);

  query<HTMLButtonElement>('[data-model="openai/gpt-5-codex"]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('GPT-5 Codex');

  // The reasoning scale comes from the same answer, not from the descriptor, and
  // it is the composer's own chip that carries it.
  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') !== null);
  expect(effortDots()).toEqual(['think', 'think-hard']);
  press('Escape');
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') === null);

  // The probed model reaches the thread the first send creates.
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the agent own model';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.model).toBe('openai/gpt-5-codex');
});

test('past twelve models the column gets a search field, prefix groups and keyboard picking', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  // Claude lists ten models: short enough to stay a plain list.
  expect(document.querySelector('[data-testid=picker-search]')).toBeNull();

  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=opencode]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-probing]') === null);
  await waitFor(() => document.querySelector('[data-testid=picker-search]') !== null);
  expect(shownModels().length).toBe(23);
  expect(groupLabels()).toEqual(['anthropic', 'openai', 'openrouter', 'opencode', 'nvidia']);
  // The column opens on a long list, so the field already has the caret.
  const search = query<HTMLInputElement>('[data-testid=picker-search]');
  expect(document.activeElement).toBe(search);

  await type(search, 'sonnet');
  await waitFor(() => shownModels().length === 4);
  // The agent's own default is pinned first whatever the query.
  expect(shownModels()).toEqual([
    'default',
    'anthropic/claude-sonnet-5',
    'openrouter/anthropic/claude-sonnet-4-5',
    'opencode/claude-sonnet-5'
  ]);
  expect(groupLabels()).toEqual(['anthropic', 'openrouter', 'opencode']);

  // Down onto the pinned row, down again onto the first match, Enter to take it.
  press('ArrowDown');
  press('ArrowDown');
  expect((document.activeElement as HTMLElement).getAttribute('data-model')).toBe('anthropic/claude-sonnet-5');
  press('Enter');
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('Claude Sonnet 5');

  // A query nothing answers says so, and Escape clears it before it closes anything.
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-search]') !== null);
  await type(query<HTMLInputElement>('[data-testid=picker-search]'), 'nothing here');
  await waitFor(() => document.querySelector('[data-testid=picker-no-models]') !== null);
  expect(shownModels()).toEqual(['default']);

  press('Escape');
  await waitFor(() => shownModels().length === 23);
  expect(document.querySelector('[data-testid=composer-picker-menu]')).not.toBeNull();
  expect(query<HTMLInputElement>('[data-testid=picker-search]').value).toBe('');

  press('Escape');
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);

  // The searched model is the one the first send writes on the thread.
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the model I searched for';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.model).toBe('anthropic/claude-sonnet-5');
});

test('the reasoning slider sets the effort of the picked model, and the chip follows', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') !== null);
  expect(effortDots()).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink']);
  // Nothing chosen yet, so the model's own default reads as the active one.
  const track = query('[data-testid=effort-track]');
  expect(track.getAttribute('aria-valuenow')).toBe('2');
  expect(track.getAttribute('aria-valuetext')).toBe('High');

  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=xhigh]').click();
  await waitFor(() => query('[data-testid=effort-track]').getAttribute('aria-valuenow') === '3');
  // Picking a level keeps the popover open: it is a setting of the model, not a choice of its own.
  expect(document.querySelector('[data-testid=composer-effort-menu]')).not.toBeNull();
  // The level reads on its own chip; the picker's label names the model alone.
  expect(query('[data-testid=composer-picker]').textContent).toContain('Claude Sonnet 5');
  expect(query('[data-testid=composer-picker]').textContent).not.toContain('Extra high');
  await waitFor(() => query('[data-testid=composer-effort]').textContent?.trim() === 'Extra high');

  // The dots are filled up to the one that is live, and no further.
  const filled = Array.from(document.querySelectorAll('[data-dot]')).filter((dot) => dot.classList.contains('on'));
  expect(filled.map((dot) => dot.getAttribute('data-dot'))).toEqual(['low', 'medium', 'high', 'xhigh']);

  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=high]').click();
  await waitFor(() => query('[data-testid=composer-effort]').textContent?.trim() === 'High');

  // The draft carries the effort into the thread the first send creates.
  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=xhigh]').click();
  await waitFor(() => query('[data-testid=composer-effort]').textContent?.trim() === 'Extra high');
  press('Escape');
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Think harder about the caps';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.effort).toBe('xhigh');
});

test('a right click on a thread row opens the context menu, and Archive removes the row', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length === 4);

  const row = query<HTMLButtonElement>('[data-thread-id="t-bench"]');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  const labels = Array.from(document.querySelectorAll('[data-testid=context-menu] [data-row]')).map((el) => el.textContent?.trim());
  expect(labels).toEqual(['Open', 'Rename', 'Regenerate title', 'Pin', 'Archive']);

  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=archive]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);
  await waitFor(() => document.querySelectorAll('[data-testid=thread-row]').length === 3);
  expect(document.querySelector('[data-thread-id="t-bench"]')).toBeNull();
});

test('a permission left pending is read back on connect and answered from its card', async () => {
  await mountOnFake();
  // Nothing streamed here: the request comes from permissions.list, not the event.
  await waitFor(() => store.pendingPermissions.some((p) => p.threadId === 't-bench'));
  await waitFor(() => document.querySelector('[data-thread-id="t-bench"]') !== null);

  query<HTMLButtonElement>('[data-thread-id="t-bench"]').click();
  await waitFor(() => store.openThread?.id === 't-bench');
  await waitFor(() => document.querySelector('[data-testid=permission-card]') !== null);
  expect(query('[data-testid=permission-card]').getAttribute('data-decision')).toBe('pending');
  expect(query('[data-testid=permission-input]').textContent).toContain('run.ts');

  query<HTMLButtonElement>('[data-testid=permission-allow]').click();
  await waitFor(() => query('[data-testid=permission-card]').getAttribute('data-decision') === 'allow');
  expect(store.pendingPermissions.some((p) => p.threadId === 't-bench')).toBe(false);
  expect(query('[data-testid=permission-verdict]').textContent?.trim()).toBe('Allowed');
});

test('the theme setting stamps the light palette and remembers the choice', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  // The theme lives on its own tab now, not on General.
  await waitFor(() => document.querySelector('[data-testid=settings-tab-appearance]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-appearance]').click();
  await waitFor(() => document.querySelector('[data-testid=theme-light]') !== null);
  expect(query('[data-testid=theme-system]').getAttribute('aria-pressed')).toBe('true');

  query<HTMLButtonElement>('[data-testid=theme-light]').click();
  await waitFor(() => document.documentElement.dataset.theme === 'light');
  expect(window.localStorage.getItem('boite.theme')).toBe('light');
  expect(query('[data-testid=theme-light]').getAttribute('aria-pressed')).toBe('true');

  query<HTMLButtonElement>('[data-testid=theme-dark]').click();
  await waitFor(() => document.documentElement.dataset.theme === undefined);
  expect(window.localStorage.getItem('boite.theme')).toBe('dark');
  expect(query('[data-testid=theme-dark]').getAttribute('aria-pressed')).toBe('true');

  // The store is one module-level singleton: leave the next test on the chat.
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});

test('the keybindings file moves a chord, takes one away, and the Keyboard page says so', async () => {
  await mountOnFake();
  await waitFor(() => store.keybindings !== null);

  // The fake's file binds the light theme to Ctrl+Shift+L and unbinds the panel.
  const light = new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  expect(document.body.dispatchEvent(light)).toBe(false);
  await waitFor(() => document.documentElement.dataset.theme === 'light');

  await waitFor(() => store.openThread !== null);
  const panel = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  expect(document.body.dispatchEvent(panel)).toBe(true);
  expect(store.panelOpen).toBe(false);

  // A default still stands, and the tooltip and the palette hint read the table too.
  expect(query<HTMLButtonElement>('[data-testid=nav-settings]').title).toBe('Settings (Ctrl+,)');
  const settings = new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true });
  expect(document.body.dispatchEvent(settings)).toBe(false);
  await waitFor(() => document.querySelector('[data-testid=settings-tab-keyboard]') !== null);

  query<HTMLButtonElement>('[data-testid=settings-tab-keyboard]').click();
  await waitFor(() => document.querySelector('[data-testid=keyboard-page]') !== null);
  const keyOf = (id: string) =>
    query(`[data-testid=keybinding-row][data-command=${id}] [data-testid=keybinding-key]`).textContent?.trim();
  expect(keyOf('theme-light')).toBe('Ctrl+Shift+L');
  expect(keyOf('panel')).toBe('none');
  expect(keyOf('new-thread')).toBe('Ctrl+N');
  expect(query('[data-testid=keybinding-row][data-command=theme-light]').classList.contains('custom')).toBe(true);
  expect(query('[data-testid=keybinding-row][data-command=new-thread]').classList.contains('custom')).toBe(false);
  expect(query('[data-testid=keybindings-path]').textContent).toBe('C:\\Users\\you\\AppData\\Local\\boite2\\keybindings.json');
  expect(query('[data-testid=keybinding-error]').textContent).toContain('"trace": "t" has no modifier');

  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});

test('removing a project asks first, and Cancel keeps it', async () => {
  await mountOnFake();
  const head = query('[data-project-id="p-brain"][data-testid=project-row]');
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=remove]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  expect(document.querySelector('[data-testid=confirm-dialog]')?.textContent).toContain('brain');

  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(store.projects.length).toBe(2);
});

test('an isolated account that is not logged in logs in from the Accounts page', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);

  // Only the isolated seat is unauthenticated; the default login has no button.
  expect(document.querySelectorAll('[data-testid=account-login]').length).toBe(1);
  expect(query('[data-testid=account-login]').getAttribute('data-account-id')).toBe('a-claude-side');

  query<HTMLButtonElement>('[data-testid=account-login]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-url]') !== null);
  const link = query<HTMLAnchorElement>('[data-testid=account-login-url]');
  expect(link.getAttribute('href')).toBe('https://example.invalid/login?code=fake');
  expect(link.getAttribute('target')).toBe('_blank');

  const code = query<HTMLInputElement>('[data-testid=account-login-input]');
  code.value = 'pasted-code';
  code.dispatchEvent(new Event('input', { bubbles: true }));
  query<HTMLButtonElement>('[data-testid=account-login-send]').click();

  await waitFor(() => store.accountOf('a-claude-side')?.status === 'ok');
  await waitFor(() => document.querySelector('[data-testid=account-login-row]') === null);
  expect(document.querySelector('[data-testid=account-login]')?.textContent).toContain('Reconnect');

  // The store is one module-level singleton: leave the next test on the chat.
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});

test('the trace panel shows the I/O a process moved, and none for a record that measured nothing', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');

  if (!store.panelOpen) query<HTMLButtonElement>('[data-testid=tab-trace]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=trace-row]').length === 3);

  expect(query('[data-testid=trace-panel] thead').textContent).toContain('I/O');
  const cellOf = (pid: number): string =>
    query(`[data-testid=trace-row][data-pid="${pid}"] [data-testid=trace-io]`).textContent?.trim() ?? '';
  // 1_240_000 bytes through the same `bytes()` the memory column uses.
  expect(cellOf(21_140)).toBe('1 MB');
  expect(cellOf(21_402)).toBe('80 kB');
  // Nothing measured reads like an unmeasured peak memory, from the same formatter.
  expect(cellOf(21_460)).toBe('none');
  expect(query('[data-testid=trace-row][data-pid="21460"]').textContent).toContain('none');
});

test('the trace table fits the panel: base names, no pid column, nothing scrolling sideways', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');

  if (!store.panelOpen) query<HTMLButtonElement>('[data-testid=tab-trace]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=trace-row]').length === 3);

  // The pid is not a column any more, only an attribute and a line of the tooltip.
  const headers = Array.from(query('[data-testid=trace-panel] thead').querySelectorAll('th')).map(
    (th) => th.textContent?.trim() ?? ''
  );
  expect(headers).toEqual(['Executable', 'Duration', 'CPU', 'Peak memory', 'I/O', 'Exit']);

  const exe = query('[data-testid=trace-row][data-pid="21140"] td.exe');
  expect(exe.textContent?.trim()).toBe('claude.exe');
  expect(exe.getAttribute('data-exe')).toBe('C:\\tools\\claude\\claude.exe');
  expect(exe.getAttribute('title')).toContain('C:\\tools\\claude\\claude.exe');
  expect(exe.getAttribute('title')).toContain('pid 21140');

  // Every measurement is right-aligned on tabular figures.
  const row = query('[data-testid=trace-row][data-pid="21402"]');
  expect(row.querySelectorAll('td.num').length).toBe(4);

  // jsdom lays nothing out, so both are 0 here: the real widths are in
  // scratchpad/trace-width-capture.ts and its capture.
  const table = query<HTMLTableElement>('[data-testid=trace-table]');
  expect(table.scrollWidth).toBe(table.clientWidth);
});

const SEEDED_THINKING = 'The table wants a row per process';

test('a thinking part is folded, opens on its toggle, and a new turn shows it before the answer', async () => {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  await waitFor(() => document.querySelector('[data-testid=thinking-part]') !== null);

  const toggle = query<HTMLButtonElement>('[data-testid=thinking-toggle]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.textContent).toContain('Thinking');
  expect(document.querySelector('[data-testid=thinking-text]')).toBeNull();

  toggle.click();
  await waitFor(() => document.querySelector('[data-testid=thinking-text]') !== null);
  expect(query('[data-testid=thinking-text]').textContent).toContain(SEEDED_THINKING);
  expect(query<HTMLButtonElement>('[data-testid=thinking-toggle]').getAttribute('aria-expanded')).toBe('true');

  // A new turn on the same thread: the reasoning part comes before the answer.
  const before = store.openThread?.messages.length ?? 0;
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'what the trace panel needs';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => (store.openThread?.messages.length ?? 0) === before + 2);
  const answer = store.openThread?.messages.at(-1);
  await waitFor(() => answer?.state === 'complete');
  expect(answer?.parts[0]).toEqual({
    type: 'thinking',
    text: 'thinking about: what the trace panel needs'
  });
  expect(answer?.parts[1]).toEqual({ type: 'text', text: 'what the trace panel needs' });
  expect(document.querySelectorAll('[data-testid=thinking-part]').length).toBe(2);
});

/** Opens the Accounts page on the fake and returns the login link it shows. */
async function loginLink(): Promise<HTMLAnchorElement> {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  query<HTMLButtonElement>('[data-testid=account-login]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-url]') !== null);
  return query<HTMLAnchorElement>('[data-testid=account-login-url]');
}

/** The store is one module-level singleton: leave the next test on the chat. */
async function backToChat(): Promise<void> {
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
}

const LOGIN_URL = 'https://example.invalid/login?code=fake';

test('in the shell an external link goes to the system browser instead of the webview', async () => {
  const link = await loginLink();
  window.__TAURI_INTERNALS__ = {};

  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(click);

  await waitFor(() => openUrl.mock.calls.length === 1);
  expect(openUrl).toHaveBeenCalledWith(LOGIN_URL);
  expect(click.defaultPrevented).toBe(true);
  // The markup is untouched, so a right-click copy still works.
  expect(link.getAttribute('href')).toBe(LOGIN_URL);
  expect(link.getAttribute('target')).toBe('_blank');

  await backToChat();
});

test('outside the shell the same link goes through window.open', async () => {
  const opened = vi.fn(() => null);
  const original = window.open;
  window.open = opened as unknown as typeof window.open;
  try {
    const link = await loginLink();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await waitFor(() => opened.mock.calls.length === 1);
    expect(opened).toHaveBeenCalledWith(LOGIN_URL, '_blank', 'noopener,noreferrer');
    expect(openUrl).not.toHaveBeenCalled();

    await backToChat();
  } finally {
    window.open = original;
  }
});

test('a ctrl-click on an external link is left alone', async () => {
  const opened = vi.fn(() => null);
  const original = window.open;
  window.open = opened as unknown as typeof window.open;
  try {
    const link = await loginLink();
    window.__TAURI_INTERNALS__ = {};
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(click);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openUrl).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);

    await backToChat();
  } finally {
    window.open = original;
  }
});

const STREAMED_TOOL_INPUT = '{"command":"echo streamed","description":"a streamed input"}';

test('a tool card shows the input as the model types it, then switches to the parsed one', async () => {
  await mountOnFake();

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'call [tool-stream] please';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  // The card opens itself while the json arrives, so sampling the pre catches
  // the growth without racing a click on the toggle. The thread already holds
  // seeded tool cards: only the streaming one is this test's.
  await waitFor(() => document.querySelector('[data-testid=tool-card][data-streaming=true]') !== null);
  const card = query('[data-testid=tool-card][data-streaming=true]');
  const typed: string[] = [];
  const lines: string[] = [];
  while (card.dataset.streaming === 'true') {
    typed.push(card.querySelector('[data-testid=tool-input]')?.textContent ?? '');
    lines.push(card.querySelector('.line')?.textContent ?? '');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  // Every sample is a prefix of the json, and at least two of them differ: that
  // is the input growing rather than landing whole.
  const partials = typed.filter((text) => text.length > 0);
  expect(partials.length).toBeGreaterThan(0);
  for (const text of partials) expect(STREAMED_TOOL_INPUT.startsWith(text)).toBe(true);
  expect(new Set(typed).size).toBeGreaterThan(1);
  expect(partials.at(-1)).toBe(STREAMED_TOOL_INPUT);

  // The summary reads the half-typed value, never the raw json.
  const summaries = lines.filter((text) => text.length > 0);
  expect(summaries.length).toBeGreaterThan(0);
  for (const text of summaries) expect('echo streamed'.startsWith(text)).toBe(true);

  // Once the parsed input lands the card folds back to its one line. The body
  // stays built so the fold can animate its height both ways; what says it is
  // shut is the toggle, and the fold around it holds no open track.
  await waitFor(() => card.dataset.streaming === 'false');
  expect(card.querySelector('[data-testid=tool-toggle]')?.getAttribute('aria-expanded')).toBe('false');
  expect(card.querySelector('.fold')?.classList.contains('open')).toBe(false);
  expect(card.querySelector('.line')?.textContent).toBe('echo streamed');

  card.querySelector<HTMLButtonElement>('[data-testid=tool-toggle]')?.click();
  await waitFor(() => card.querySelector('[data-testid=tool-input]') !== null);
  const shown = card.querySelector('[data-testid=tool-input]')?.textContent ?? '';
  expect(shown).toContain('"command": "echo streamed"');
  expect(shown).not.toBe(STREAMED_TOOL_INPUT);
});

test('a tool card shows the diff, the markdown and the image it produced', async () => {
  await mountOnFake();

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'show me [diff] [doc] [image]';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  // Folded, each of the three cards says what it carries.
  await waitFor(() => document.querySelectorAll('[data-testid=tool-document-chip]').length === 3);
  expect(
    Array.from(document.querySelectorAll('[data-testid=tool-document-chip]')).map((el) => el.textContent)
  ).toEqual(['1 diff', '1 doc', '1 doc']);

  // Open every card that carries documents.
  for (const chip of Array.from(document.querySelectorAll('[data-testid=tool-document-chip]'))) {
    chip.closest('[data-testid=tool-card]')?.querySelector<HTMLButtonElement>('[data-testid=tool-toggle]')?.click();
  }
  await waitFor(() => document.querySelectorAll('[data-testid=tool-document]').length === 3);
  expect(
    Array.from(document.querySelectorAll('[data-testid=tool-document]')).map((el) => el.getAttribute('data-kind'))
  ).toEqual(['diff', 'markdown', 'image']);

  // The diff: one removed line and one added line, each on its own gutter.
  const diff = query('[data-testid=tool-document][data-kind=diff]');
  const gutters = Array.from(diff.querySelectorAll('[data-testid=diff-row]')).map(
    (row) => row.querySelector('.gutter')?.textContent ?? ''
  );
  expect(gutters).toContain('-');
  expect(gutters).toContain('+');
  expect(query('[data-testid=diff-row][data-kind=remove] .text').textContent).toContain('return start();');
  expect(query('[data-testid=diff-row][data-kind=add] .text').textContent).toContain('warm: true');

  // The markdown: its title above, its heading and its list rendered.
  const markdown = query('[data-testid=tool-document][data-kind=markdown]');
  expect(markdown.querySelector('.section-label')?.textContent).toBe('README.md');
  expect(markdown.querySelector('h3')?.textContent).toBe('README');
  expect(markdown.querySelector('li')?.textContent).toBe('the first item');

  // The image: a data url built from the base64, and the alt the core sent.
  const image = query<HTMLImageElement>('[data-testid=tool-document][data-kind=image] img');
  expect(image.getAttribute('src')?.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
  expect(image.alt).toBe('one pixel');
});

test('a provider Boite installs says so in the picker and sends you to Settings, then becomes pickable', async () => {
  await mountOnFake();
  // An open thread locks its provider; a draft is where another one can be picked.
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);

  // Nothing is on the machine yet: the tile is pickable and its column says why
  // it offers no model. The download itself lives on the Accounts page.
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=antigravity]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-not-installed]') !== null);
  expect(document.querySelector('[data-testid=install-start]')).toBeNull();
  expect(shownModels()).toEqual([]);

  query<HTMLButtonElement>('[data-testid=picker-install-settings]').click();
  await waitFor(() => store.page === 'settings' && store.settingsTab === 'accounts');
  // The picker closed on the way out.
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);

  // The fake ticks for about two seconds, then the provider is one tile like any other.
  await store.installProvider('antigravity');
  await waitFor(() => store.installOf('antigravity')?.state === 'installed', 2000);
  store.showChat();
  await waitFor(() => document.querySelector('[data-testid=composer-picker]') !== null);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=antigravity]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-not-installed]') === null);
  await waitFor(() => shownModels().length > 0);

  query<HTMLButtonElement>('[data-model=default]').click();
  await waitFor(() => (query('[data-testid=composer-picker]').textContent ?? '').includes('Antigravity'));
});

test('the Providers page says where each managed install stands and offers Update on the one behind', async () => {
  store.draft = null;
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  // The nav entry is named after what the page is now about.
  expect(query('[data-testid=settings-tab-accounts]').textContent?.trim()).toBe('Providers');

  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  await waitFor(() => document.querySelector('[data-testid=managed-providers]') !== null);
  expect(query('[data-testid=managed-providers] h2').textContent?.trim()).toBe('Installed by Boite');

  // Nothing on the machine: the size rides in the words, the button is one verb.
  const absent = query('[data-testid=install-control][data-provider=antigravity]');
  expect(absent.querySelector('[data-testid=install-status]')?.textContent?.trim()).toBe(
    'Not installed, 447 MB'
  );
  expect(absent.querySelector('[data-testid=install-start]')?.textContent?.trim()).toBe('Install');
  expect(absent.querySelector('[data-testid=install-remove]')).toBeNull();

  // Down and one release behind: both versions in the row, Update beside Remove.
  const behind = query('[data-testid=install-control][data-provider=opencode]');
  expect(behind.getAttribute('data-update')).toBe('true');
  expect(behind.querySelector('[data-testid=install-status]')?.textContent?.trim()).toBe(
    'Version 0.4.12, 0.5.0 available'
  );
  expect(behind.querySelector('[data-testid=install-update]')?.textContent?.trim()).toBe('Update');
  expect(behind.querySelector('[data-testid=install-remove]')).not.toBeNull();

  // The update is the same download, and the row settles on the new version alone.
  query<HTMLButtonElement>('[data-testid=install-update]').click();
  // While it runs the row is the track and Cancel, the same one a first install draws.
  await waitFor(() => document.querySelector('[data-testid=install-progress]') !== null);
  expect(document.querySelector('[data-testid=install-cancel]')).not.toBeNull();

  await waitFor(
    () =>
      query(
        '[data-testid=install-control][data-provider=opencode] [data-testid=install-status]'
      ).textContent?.trim() === 'Version 0.5.0',
    2000
  );
  const updated = query('[data-testid=install-control][data-provider=opencode]');
  expect(updated.getAttribute('data-update')).toBe('false');
  expect(document.querySelector('[data-testid=install-update]')).toBeNull();

  // The store is one module-level singleton: leave the next test on the chat.
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => store.page === 'chat');
});

test('Regenerate title in the thread menu waits on the agent, then the row and the header carry its words', async () => {
  store.draft = null;
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  const before = store.threads.find((thread) => thread.id === 't-trace')?.title;
  expect(before).toBe('Finish the trace tab');

  const row = query<HTMLButtonElement>('[data-thread-id="t-trace"]');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=retitle]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);

  // While the fake writes, the menu says so and takes the item away.
  expect(store.retitling).toEqual(['t-trace']);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  const waiting = query<HTMLButtonElement>('[data-testid=context-menu] [data-value=retitle]');
  expect(waiting.textContent?.trim()).toBe('Writing a title');
  expect(waiting.disabled).toBe(true);
  press('Escape');

  await waitFor(() => store.retitling.length === 0);
  const after = store.threads.find((thread) => thread.id === 't-trace');
  expect(after).toMatchObject({ title: 'Echo: What does the trace tab', titleSource: 'agent' });
  await waitFor(() => query('[data-thread-id="t-trace"]').textContent?.includes('Echo: What does the trace tab') === true);

  // The open thread is the same one: its header follows.
  await store.open('t-trace');
  await waitFor(() => query('[data-testid=thread-title]').textContent?.trim() === 'Echo: What does the trace tab');
});

test('the chat header keeps the mark and the title, the status word riding the mark', async () => {
  // The store is the singleton every test shares: a draft left open by another
  // one would keep the boot from opening a thread at all.
  store.draft = null;
  await mountOnFake();

  // The word used to sit beside the title and repeat what the mark already says.
  expect(document.querySelector('[data-testid=thread-status-label]')).toBeNull();

  const mark = query('[data-testid=thread-status]');
  expect(mark.getAttribute('data-status')).toBe('idle');
  expect(mark.getAttribute('title')).toBe('idle');
  expect(mark.getAttribute('aria-label')).toBe('idle');
  expect(query('[data-testid=thread-title]').textContent?.trim()).toBe(store.openThread?.title);
});

test('the Accounts page picks a provider with the menu, never a native select', async () => {
  store.draft = null;
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);

  query<HTMLButtonElement>('[data-testid=accounts-page] header button').click();
  await waitFor(() => document.querySelector('[data-testid=account-provider]') !== null);
  expect(document.querySelector('[data-testid=accounts-page] select')).toBeNull();

  const trigger = query<HTMLButtonElement>('[data-testid=account-provider]');
  expect(trigger.textContent?.trim()).toBe('Claude');

  trigger.click();
  await waitFor(() => document.querySelector('[data-testid=account-provider-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=account-provider-menu] [data-value=opencode]').click();
  await waitFor(() => (query('[data-testid=account-provider]').textContent ?? '').includes('OpenCode'));
  expect(document.querySelector('[data-testid=account-provider-menu]')).toBeNull();
});

test('account lifecycle removal asks first and cancellation keeps the account', async () => {
  await mountOnFake();
  store.showSettings('accounts');
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  const selector = '[data-testid=account-remove][data-account-id=a-claude-side]';
  expect(document.querySelector(selector)).not.toBeNull();
  query<HTMLButtonElement>(selector).click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  expect(query('[data-testid=confirm-dialog]').textContent).toContain('isolation directory');
  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(store.accounts.some((a) => a.id === 'a-claude-side')).toBe(true);
  query<HTMLButtonElement>(selector).click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => !store.accounts.some((a) => a.id === 'a-claude-side'));
});

test('account lifecycle cancel button stops login and restores retry', async () => {
  await mountOnFake();
  store.showSettings('accounts');
  await waitFor(() => document.querySelector('[data-testid=account-login]') !== null);
  query<HTMLButtonElement>('[data-testid=account-login]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-cancel]') !== null);
  query<HTMLButtonElement>('[data-testid=account-login-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-row]') === null);
  expect(document.querySelector('[data-testid=account-login]')).not.toBeNull();
});

test('account lifecycle provider metadata gates login and default-location controls', async () => {
  await mountOnFake();
  store.showSettings('accounts');
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  const side = store.accounts.find((a) => a.id === 'a-claude-side')!;
  const provider = store.providers.find((p) => p.id === 'claude')!;
  side.status = 'unknown';
  await waitFor(() => document.querySelector('[data-testid=account-login]') !== null);
  store.logins[side.id] = { state: 'failed', output: 'refused', url: null, exitCode: 1 };
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector('[data-testid=account-login]')).not.toBeNull();
  provider.login = false;
  await waitFor(() => document.querySelector('[data-testid=account-login]') === null);
  query<HTMLButtonElement>('[data-testid=accounts-page] header button').click();
  await waitFor(() => document.querySelector('[data-testid=account-default-location]') !== null);
  query<HTMLInputElement>('[data-testid=account-default-location]').click();
  provider.alwaysIsolated = true;
  await waitFor(() => document.querySelector('[data-testid=account-default-location]') === null);
  await type(query<HTMLInputElement>('[data-testid=accounts-page] form input:not([type])'), 'isolated seat');
  query<HTMLFormElement>('[data-testid=accounts-page] form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => store.accounts.some((a) => a.label === 'isolated seat'));
  expect(store.accounts.find((a) => a.label === 'isolated seat')?.isolationDir).not.toBeNull();
});

test('browser Add project opens a path form and starts a draft in the added folder', async () => {
  await mountOnFake();
  const before = store.projects.length;
  store.sidebarOpen = true;
  query<HTMLButtonElement>('[data-testid=add-project]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.page).toBe('chat');
  expect(document.querySelector('[data-testid=add-project-form]')).not.toBeNull();
  await type(query<HTMLInputElement>('[data-testid=project-path]'), 'D:\\work\\another-project');
  query<HTMLButtonElement>('[data-testid=project-add]').click();
  await waitFor(() => store.projects.length === before + 1);
  const added = store.projects.find((p) => p.path === 'D:\\work\\another-project')!;
  expect(store.draft?.projectId).toBe(added.id);
  expect(store.sidebarOpen).toBe(false);
  await waitFor(() => document.querySelector('[data-testid=add-project-form]') === null);
});

test('browser Add project keeps refused paths and Escape returns to its button', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=add-project]').click();
  await waitFor(() => document.querySelector('[data-testid=project-path]') !== null);
  const field = query<HTMLInputElement>('[data-testid=project-path]');
  await waitFor(() => document.activeElement === field);
  const client = store.client!;
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'projects.add') return Promise.reject(new Error('folder not found'));
    return call<RpcMethodName>(method, params);
  });
  try {
    await type(field, 'D:\\missing-project');
    query<HTMLButtonElement>('[data-testid=project-add]').click();
    await waitFor(() => store.error === 'folder not found');
    expect(field.value).toBe('D:\\missing-project');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('[data-testid=add-project-form]') === null);
    expect(document.activeElement).toBe(query('[data-testid=add-project]'));
    expect(store.page).toBe('chat');
  } finally {
    spy.mockRestore();
  }
});

test('first run uses the same path form to open its first project', async () => {
  await mountOnFake();
  store.projects = [];
  store.openThread = null;
  store.draft = null;
  await waitFor(() => document.querySelector('[data-testid=first-run]') !== null);
  await type(query<HTMLInputElement>('[data-testid=project-path]'), 'D:\\work\\first-project');
  query<HTMLButtonElement>('[data-testid=project-add]').click();
  await waitFor(() => store.draft !== null);
  expect(store.openProject?.path).toBe('D:\\work\\first-project');
  expect(document.querySelector('[data-testid=first-run]')).toBeNull();
});

test('an ACP login accepts the phone redirect URL through the login input', async () => {
  await mountOnFake();
  store.showSettings('accounts');
  await store.installProvider('antigravity');
  await waitFor(() => store.providerOf('antigravity')?.available === true, 2000);
  const loginButton = '[data-testid=account-login][data-account-id=a-antigravity]';
  await waitFor(() => document.querySelector(loginButton) !== null);
  query<HTMLButtonElement>(loginButton).click();
  const row = '[data-testid=account-login-row][data-account-id=a-antigravity]';
  await waitFor(() => document.querySelector(row) !== null);
  const field = document.querySelector<HTMLInputElement>(`${row} [data-testid=account-login-input]`);
  expect(field).not.toBeNull();
  expect(field!.placeholder).toMatch(/redirect URL/i);
  const send = vi.spyOn(store, 'sendLoginInput');
  try {
    const redirect = 'http://127.0.0.1:54321/oauth/callback?code=demo';
    await type(field!, redirect);
    query<HTMLButtonElement>(`${row} [data-testid=account-login-send]`).click();
    await waitFor(() => store.accountOf('a-antigravity')?.status === 'ok');
    expect(send).toHaveBeenCalledWith('a-antigravity', redirect);
  } finally {
    send.mockRestore();
  }
});
