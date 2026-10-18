import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { FakeClient } from '../lib/fake-client';
import { store } from '../lib/store.svelte';
import { HIDDEN_RELEASE_MS } from '../lib/terminal-session.svelte';
import { query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

/**
 * jsdom has no WebGL: this addon counts the contexts a screen takes and gives
 * back. Like xterm's, its dispose removes its canvas and leaves the context be.
 */
const contexts = vi.hoisted(() => ({ made: 0, disposed: 0, lost: 0, loss: null as (() => void) | null }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    canvas: HTMLCanvasElement | null = null;
    constructor() { contexts.made++; }
    activate(term: { element: HTMLElement }) {
      const gl = { getExtension: (name: string) => name === 'WEBGL_lose_context' ? { loseContext: () => { contexts.lost++; } } : null };
      this.canvas = Object.assign(document.createElement('canvas'), { getContext: (type: string) => type === 'webgl2' ? gl : null }) as unknown as HTMLCanvasElement;
      term.element.append(this.canvas);
    }
    dispose() { this.canvas?.remove(); contexts.disposed++; }
    onContextLoss(listener: () => void) { contexts.loss = listener; return { dispose() {} }; }
  }
}));

test('a hidden terminal gives its WebGL context back at once and its xterm after a while, then comes back from the core', async ({ app: _app }) => {
  await waitFor(() => store.openThread !== null);
  const threadId = store.openThread!.id;
  const toggle = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true }));
  const drawn = () => document.querySelector('[data-testid=terminal-drawer]')?.textContent?.includes('PS ') === true;

  toggle();
  await waitFor(drawn);
  expect(query('[data-testid=terminal]').dataset['gpu']).toBe('webgl');
  expect(contexts).toMatchObject({ made: 1, disposed: 0, lost: 0 });
  const element = query('[data-testid=terminal] .terminal-screen');

  // Out of the page, the screen holds no context; back, a new one draws what it kept.
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const attach = vi.spyOn(store, 'openTerminal');
  toggle();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') === null);
  expect(contexts).toMatchObject({ made: 1, disposed: 1, lost: 1 });
  toggle();
  await waitFor(drawn);
  expect(contexts).toMatchObject({ made: 2, disposed: 1, lost: 1 });
  expect(attach).not.toHaveBeenCalled();

  // Hidden for HIDDEN_RELEASE_MS, the xterm goes too: shown again, it is drawn from the core's snapshot.
  timers.mockClear();
  toggle();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') === null);
  const release = timers.mock.calls.find(([, delay]) => delay === HIDDEN_RELEASE_MS)?.[0] as (() => void) | undefined;
  expect(release).toBeTypeOf('function');
  release!();
  expect(element.childElementCount).toBe(0);
  expect(store.terminalShown(threadId)).toBe(false);
  toggle();
  await waitFor(drawn);
  expect(attach).toHaveBeenCalledTimes(1);
  expect(attach.mock.calls[0]?.[0]).toBe(threadId);
  expect(query('[data-testid=terminal] .terminal-screen')).toBe(element);
  expect(contexts).toMatchObject({ made: 3, disposed: 2, lost: 2 });

  // A screen whose context the browser took falls back to the DOM, and asks for
  // no other, drawn again after a release included.
  contexts.loss!();
  await waitFor(() => query('[data-testid=terminal]').dataset['gpu'] === 'dom');
  timers.mockClear();
  toggle();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') === null);
  (timers.mock.calls.find(([, delay]) => delay === HIDDEN_RELEASE_MS)?.[0] as () => void)();
  toggle();
  await waitFor(drawn);
  expect(attach).toHaveBeenCalledTimes(2);
  expect(query('[data-testid=terminal]').dataset['gpu']).toBe('dom');
  expect(contexts.made).toBe(3);

  // A released tab still hears its shell. The command's end comes while the
  // hidden xterm has only queued it (xterm parses on a later task) and the
  // release runs first: the dot still turns red, and the next command clears it.
  const first = `terminal:${threadId}`;
  const shell = store.client as FakeClient;
  const firstTab = () => [...document.querySelectorAll('[data-testid=terminal-tab]')].find((tab) => !tab.classList.contains('selected'));
  const dot = () => firstTab()?.querySelector('[data-testid=terminal-status]')?.classList;
  shell.emitTerminalOutput(first, '\x1b]133;C\x07build\r\n');
  await waitFor(() => store.terminalScreen(first)?.running === true);
  timers.mockClear();
  store.newTerminal(threadId);
  await waitFor(() => document.querySelectorAll('[data-testid=terminal-tab]').length === 2 && store.terminalLayout(threadId)?.active !== first);
  const releaseFirst = timers.mock.calls.find(([, delay]) => delay === HIDDEN_RELEASE_MS)?.[0] as (() => void) | undefined;
  expect(releaseFirst).toBeTypeOf('function');
  expect(dot()?.contains('running')).toBe(true);
  shell.emitTerminalOutput(first, '\x1b]133;D;1\x07\x1b]133;A\x07PS C:\\work>\x1b]133;B\x07');
  releaseFirst!();
  expect(element.childElementCount).toBe(0);
  expect(store.terminalScreen(first)?.lastExit).toBe(1);
  expect(store.terminalScreen(first)?.running).toBe(false);
  await waitFor(() => dot()?.contains('failed') === true);
  store.writeTerminal(first, 'git status\r');
  await waitFor(() => store.terminalScreen(first)?.lastExit === 0);
  expect(dot()).toBeUndefined();
  expect(store.terminalLayout(threadId)?.active).not.toBe(first);
  expect(element.childElementCount).toBe(0);
  timers.mockRestore();
  attach.mockRestore();

  // Back from a dropped socket, the shell floods while its snapshot is on the
  // way: a command's end the snapshot does not hold still counts, however much
  // output follows it before the snapshot lands.
  const second = store.terminalLayout(threadId)!.active;
  shell.emitTerminalOutput(second, '\x1b]133;A\x07PS> \x1b]133;B\x07\x1b]133;C\x07');
  await waitFor(() => store.terminalScreen(second)?.running === true);
  let land!: () => void;
  const landed = new Promise<void>((resolve) => { land = resolve; });
  let taken!: () => void;
  const snapshot = new Promise<void>((resolve) => { taken = resolve; });
  const open = store.openTerminal.bind(store);
  const reopen = vi.spyOn(store, 'openTerminal').mockImplementation(async (...args) => {
    const state = await open(...args);
    taken();
    await landed;
    return state;
  });
  store.connection = 'connecting';
  flushSync();
  store.connection = 'ready';
  flushSync();
  await snapshot;
  expect(reopen).toHaveBeenCalledTimes(1);
  shell.emitTerminalOutput(second, '\x1b]133;D;1\x07\r\n');
  for (let line = 0; line < 1000; line++) shell.emitTerminalOutput(second, `line ${line}\r\n`);
  land();
  await waitFor(() => store.terminalScreen(second)?.running === false);
  expect(store.terminalScreen(second)?.lastExit).toBe(1);
  reopen.mockRestore();
});
