import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
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

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

/** The model ids the right column of the picker is showing, in order. */
function shownModels(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-model]')).map((el) => el.getAttribute('data-model'));
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

test('the picker lists providers with their accounts and the models of the one shown, legacy folded', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  // A draft opens on the first available provider, its default model.
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  const instances = Array.from(document.querySelectorAll('[data-instance]')).map((el) => el.getAttribute('data-instance'));
  expect(instances).toEqual([
    'claude::a-claude-main',
    'claude::a-claude-side',
    'echo::a-echo',
    'opencode::a-opencode'
  ]);
  expect(shownModels()).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']);

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
  query<HTMLButtonElement>('[data-instance="opencode::a-opencode"]').click();

  // While the agent is being asked, its descriptor's one model stands.
  await waitFor(() => document.querySelector('[data-testid=picker-probing]') !== null);
  expect(shownModels()).toEqual(['default']);

  await waitFor(() => document.querySelector('[data-testid=picker-probing]') === null);
  expect(shownModels()).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5-codex']);
  // The reasoning scale comes from the same answer, not from the descriptor.
  const levels = Array.from(document.querySelectorAll('[data-effort]')).map((el) => el.getAttribute('data-effort'));
  expect(levels).toEqual(['think', 'think-hard']);

  query<HTMLButtonElement>('[data-model="openai/gpt-5-codex"]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('GPT-5 Codex');

  // The probed model reaches the thread the first send creates.
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the agent own model';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.model).toBe('openai/gpt-5-codex');
});

test('the Reasoning row sets the effort of the picked model, and the default level clears the suffix', async () => {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Sonnet 5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-effort]') !== null);
  const levels = Array.from(document.querySelectorAll('[data-effort]')).map((el) => el.getAttribute('data-effort'));
  expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink']);
  // Nothing chosen yet, so the model's own default reads as the active one.
  expect(query('[data-effort=high]').getAttribute('aria-pressed')).toBe('true');

  query<HTMLButtonElement>('[data-effort=xhigh]').click();
  await waitFor(() => query('[data-effort=xhigh]').getAttribute('aria-pressed') === 'true');
  // Picking a level keeps the popover open: it is a setting of the model, not a choice of its own.
  expect(document.querySelector('[data-testid=composer-picker-menu]')).not.toBeNull();
  expect(query('[data-testid=composer-picker]').textContent).toContain('Claude Sonnet 5 · Extra high');

  query<HTMLButtonElement>('[data-effort=high]').click();
  await waitFor(() => query('[data-effort=high]').getAttribute('aria-pressed') === 'true');
  expect(query('[data-testid=composer-picker]').textContent).not.toContain('Extra high');

  // The draft carries the effort into the thread the first send creates.
  query<HTMLButtonElement>('[data-effort=xhigh]').click();
  await waitFor(() => query('[data-effort=xhigh]').getAttribute('aria-pressed') === 'true');
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
  expect(labels).toEqual(['Open', 'Rename', 'Archive']);

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
  expect(document.querySelector('[data-testid=account-login]')).toBeNull();

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
