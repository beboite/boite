import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { type RpcMethodName } from '@boite/contracts';
import { store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import type { FakeClient } from '../lib/fake-client';
import { mountOnFake, openProviderDetails, query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('Ctrl+J opens the shell of the thread under the chat, hides it again, and its cross ends the shell', async ({ app: _app }) => {
  await waitFor(() => store.openThread !== null);
  const threadId = store.openThread!.id;
  const chord = () => new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true });

  expect(document.body.dispatchEvent(chord())).toBe(false);
  await waitFor(() => document.querySelector(`[data-testid=terminal][data-terminal-id="terminal:${threadId}"]`) !== null);
  // xterm draws what the fake shell printed: its prompt, in the thread's folder.
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]')?.textContent?.includes('PS ') === true);
  expect(query('[data-testid=terminal-toggle]').classList.contains('on')).toBe(true);
  expect(query<HTMLButtonElement>('[data-testid=terminal-toggle]').title).toContain('Ctrl+J');
  await store.open(threadId);
  await waitFor(() => document.activeElement?.classList.contains('xterm-helper-textarea') === true);

  // Back from a dropped socket, the view asks the core for the shell again.
  const reopen = vi.spyOn(store, 'openTerminal');
  store.connection = 'connecting';
  flushSync();
  store.connection = 'ready';
  flushSync();
  await waitFor(() => reopen.mock.calls.length === 1);
  expect(reopen.mock.calls[0]?.[0]).toBe(threadId);
  reopen.mockRestore();

  // T3 Code's chords, in the screen only: Ctrl+D splits, Ctrl+N opens a tab, Ctrl+W ends the shell with the keyboard.
  const inTerminal = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
  const focused = (id: string) => document.activeElement?.closest(`[data-terminal-id="${id}"]`) != null;
  expect(inTerminal('d')).toBe(false);
  await waitFor(() => document.querySelectorAll('[data-testid=terminal-pane]').length === 2 && focused(`terminal:${threadId}:term-2`));
  expect(inTerminal('n')).toBe(false);
  await waitFor(() => document.querySelectorAll('[data-testid=terminal-tab]').length === 2 && focused(`terminal:${threadId}:term-3`));
  // Ctrl+N stayed the terminal's: no new thread or draft took the chat.
  expect(store.openThread?.id).toBe(threadId);
  expect(inTerminal('w')).toBe(false);
  await waitFor(() => document.querySelectorAll('[data-testid=terminal-tab]').length === 0
    && document.querySelectorAll('[data-testid=terminal-pane]').length === 2);
  expect(store.terminalLayout(threadId)?.active).toBe(`terminal:${threadId}`);
  await waitFor(() => focused(`terminal:${threadId}`));
  expect(inTerminal('w')).toBe(false);
  await waitFor(() => document.querySelectorAll('[data-testid=terminal-pane]').length === 1 && focused(`terminal:${threadId}:term-2`));

  expect(document.body.dispatchEvent(chord())).toBe(false);
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') === null);
  expect(store.terminalShown(threadId)).toBe(false);

  query<HTMLButtonElement>('[data-testid=terminal-toggle]').click();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') !== null);
  query<HTMLButtonElement>('[data-testid=terminal-close]').click();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') === null);
  expect(store.terminalShown(threadId)).toBe(false);
});

test('a marked shell shows where it is and how its last command ended, and Ctrl+Shift+H brings a past command back to the prompt', async ({ app: _app }) => {
  await waitFor(() => store.openThread !== null);
  const thread = store.openThread!;
  const id = `terminal:${thread.id}`;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => document.activeElement?.classList.contains('xterm-helper-textarea') === true);
  expect(query('[data-testid=terminal-cwd]').textContent).toBe(thread.cwd);

  // The fake shell marks each command as the core's integrated PowerShell does; `fail…` ends badly.
  store.writeTerminal(id, 'git status\r');
  store.writeTerminal(id, 'fail-build\r');
  await waitFor(() => document.querySelector('[data-testid=terminal-status]')?.classList.contains('failed') === true);

  const keys = vi.spyOn(store, 'writeTerminal');
  const screen = document.activeElement!;
  expect(screen.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))).toBe(false);
  const items = () => [...document.querySelectorAll('[data-testid=terminal-history-item]')].map((item) => item.textContent?.trim());
  await waitFor(() => items().length === 2);
  expect(items()).toEqual(['fail-build', 'git status']);

  const input = query<HTMLInputElement>('[data-testid=terminal-history-input]');
  input.value = 'git';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => items().length === 1);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[data-testid=terminal-history]') === null);
  // The line typed so far is emptied first, then the command goes in and runs.
  expect(keys.mock.calls.map((call) => call[1])).toEqual(['\x05\x15', 'git status', '\r']);
  await waitFor(() => document.activeElement?.classList.contains('xterm-helper-textarea') === true);
  keys.mockRestore();

  // Escape from the list's close button closes the list and stays there: on the page it would stop a turn.
  query<HTMLButtonElement>('[data-testid=terminal-history-open]').click();
  await waitFor(() => document.querySelector('[data-testid=terminal-history-close]') !== null);
  const close = query<HTMLButtonElement>('[data-testid=terminal-history-close]');
  close.focus();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  expect(close.dispatchEvent(escape)).toBe(false);
  await waitFor(() => document.querySelector('[data-testid=terminal-history]') === null);

  query<HTMLButtonElement>('[data-testid=terminal-close]').click();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]') === null);
});

test('OpenCode signs in from a terminal with its login command typed in, and closing it rechecks the account', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  await openProviderDetails('opencode');

  // The user's own OpenCode login gets the button too: the terminal is theirs to answer.
  const button = query<HTMLButtonElement>('[data-provider-id=opencode] [data-testid=account-login]');
  expect(button.getAttribute('data-account-id')).toBe('a-opencode');
  button.click();
  await waitFor(() => document.querySelector('[data-testid=account-login-terminal] [data-testid=terminal]') !== null);
  expect(query('[data-testid=account-login-terminal] [data-testid=terminal]').getAttribute('data-terminal-id')).toBe('login:a-opencode');
  await waitFor(() => query('[data-testid=account-login-terminal]').textContent?.includes('Select provider') === true);
  expect(query('[data-testid=account-login-terminal]').textContent).toContain('opencode auth login');
  // No piped login and its code field while the terminal holds the sign-in.
  expect(document.querySelector('[data-testid=account-login-row]')).toBeNull();
  expect(query('[data-provider-id=opencode]').getAttribute('data-step')).toBe('signing-in');

  query<HTMLButtonElement>('[data-testid=account-login-terminal-close]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-terminal]') === null);
  await waitFor(() => query('[data-provider-id=opencode]').getAttribute('data-step') === 'ready');

  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});

test('the guided connection signs OpenCode in from a terminal too, then hands it to the composer', async ({ app: _app }) => {
  // Signed out since: the dialog has a sign-in to offer.
  await waitFor(() => store.accountOf('a-opencode') !== null);
  store.accountOf('a-opencode')!.status = 'unauthenticated';
  store.openConnect('opencode');
  await waitFor(() => document.querySelector('[data-testid=connect-sign-in]') !== null);
  query<HTMLButtonElement>('[data-testid=connect-sign-in]').click();
  // The user's own OpenCode login, in a terminal: its menu is not something a pipe can answer.
  await waitFor(() => document.querySelector('[data-testid=connect-login-terminal] [data-testid=terminal]') !== null);
  expect(query('[data-testid=connect-login-terminal] [data-testid=terminal]').getAttribute('data-terminal-id')).toBe('login:a-opencode');
  await waitFor(() => query('[data-testid=connect-login-terminal]').textContent?.includes('opencode auth login') === true);
  expect(query('[data-testid=connect-step]').getAttribute('data-step')).toBe('signing-in');
  expect(document.querySelector('[data-testid=connect-login-input]')).toBeNull();
  // Escape inside the terminal steps back in the CLI's menu; it does not close the dialog.
  query('[data-testid=connect-login-terminal] [data-testid=terminal]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  flushSync();
  expect(document.querySelector('[data-testid=connect-dialog]')).not.toBeNull();

  query<HTMLButtonElement>('[data-testid=connect-login-terminal-close]').click();
  await waitFor(() => document.querySelector('[data-testid=connect-use]') !== null);
  query<HTMLButtonElement>('[data-testid=connect-use]').click();
  await waitFor(() => document.querySelector('[data-testid=connect-dialog]') === null);
  expect(store.accountOf('a-opencode')?.status).toBe('ok');
});

test('a remote terminal keeps live output and answers new cursor queries while its opening response is in flight', async () => {
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2 && store.openThread !== null);
  const remote = workspace.machines.find(machine => machine.store !== store)!;
  await workspace.select(remote.store, store.openThread!.id);
  const client = remote.store.client!;
  const call = client.call.bind(client);
  let release!: () => void;
  let snapshotReady = false;
  const writes: string[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'terminals.write') writes.push((params as { data: string }).data);
    const result = await call<RpcMethodName>(method, params);
    if (method === 'terminals.open') {
      // A query from the old screen was answered already and stays muted on replay.
      (result as { output: string }).output = '\x1b[6n' + (result as { output: string }).output;
      snapshotReady = true;
      await gate;
    }
    return result;
  });
  try {
    remote.store.toggleTerminal();
    await waitFor(() => snapshotReady);
    await call('terminals.write', { id: `terminal:${remote.store.openThread!.id}`, data: 'remote-prompt-marker' });
    // PowerShell can ask for the cursor while the opening snapshot travels back.
    // This is live output: suppressing its answer leaves the shell waiting forever.
    (client as FakeClient).emitTerminalOutput(`terminal:${remote.store.openThread!.id}`, '\x1b[6n');
    release();
    await waitFor(() => document.querySelector('[data-testid=terminal-drawer]')?.textContent?.includes('remote-prompt-marker') === true);
    await vi.waitFor(() => expect(writes.filter(data => /^\x1b\[\d+;\d+R$/.test(data))).toHaveLength(1), { timeout: 8000 });
  } finally { release(); spy.mockRestore(); }
});
