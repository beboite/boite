import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { HIDDEN_RELEASE_MS } from '../lib/terminal-session.svelte';
import { query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

/** jsdom has no WebGL: this addon counts the contexts a screen takes and gives back. */
const contexts = vi.hoisted(() => ({ made: 0, disposed: 0 }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() { contexts.made++; }
    activate() {}
    dispose() { contexts.disposed++; }
    onContextLoss() { return { dispose() {} }; }
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
  expect(contexts).toEqual({ made: 1, disposed: 0 });
  const element = query('[data-testid=terminal] .terminal-screen');

  // Out of the page, the screen holds no context; back, a new one draws what it kept.
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const attach = vi.spyOn(store, 'openTerminal');
  toggle();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') === null);
  expect(contexts.disposed).toBe(1);
  toggle();
  await waitFor(drawn);
  expect(contexts).toEqual({ made: 2, disposed: 1 });
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
  expect(contexts).toEqual({ made: 3, disposed: 2 });
  timers.mockRestore();
  attach.mockRestore();
});
