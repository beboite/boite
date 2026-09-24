import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RpcEvents } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { commandLine, pickShell, threadTerminalId } from '../src/terminals.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const ECHO_LOGIN_SCRIPT = fileURLToPath(new URL('../src/providers/shipped/echo-login.ts', import.meta.url));
/** A shell with the user's profile can take a few seconds to draw its first prompt. */
const SHELL_MS = 20_000;

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

/** Everything the core printed for one terminal, as a client would have drawn it. */
function watch(client: CoreClient, id: string): { text: () => string; exited: () => RpcEvents['terminal.exited'] | null } {
  let text = '';
  let exited: RpcEvents['terminal.exited'] | null = null;
  client.on('terminal.output', (event) => {
    if (event.id === id) text += event.data;
  });
  client.on('terminal.exited', (event) => {
    if (event.id === id) exited = event;
  });
  return { text: () => text, exited: () => exited };
}

async function addTerminalLoginProvider(harness: TestCore, client: CoreClient): Promise<void> {
  const dir = join(harness.dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = { detect: {}, executable: [], isolation: { BOITE_ECHO_CONFIG_DIR: '{isolationDir}' } };
  writeFileSync(
    join(dir, 'echo-menu.json'),
    JSON.stringify({
      id: 'echo-menu',
      schemaVersion: 1,
      name: 'Echo with a terminal login',
      shortName: 'EchoMenu',
      protocol: 'echo',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'oauth-cli', session: ['.credentials.json'] },
      login: { command: [process.execPath, ECHO_LOGIN_SCRIPT], terminal: true },
      models: [{ id: 'echo', name: 'Echo', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
    }),
    'utf8',
  );
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.find((provider) => provider.id === 'echo-menu')?.login).toEqual({ kind: 'terminal' });
}

describe('terminals', () => {
  test('a thread shell runs in its working directory, takes keys, resizes, reattaches and closes', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const id = threadTerminalId(threadId);
    const seen = watch(client, id);

    await expect(client.call('terminals.open', { threadId, cols: 0, rows: 24 })).rejects.toThrow(/cols must be an integer/);
    const opened = await client.call('terminals.open', { threadId, cols: 100, rows: 30 });
    expect(opened.id).toBe(id);
    expect(opened.cwd).toBe(harness.core.threads.require(threadId).cwd);
    expect(harness.core.procs.liveCount(id)).toBeGreaterThan(0);
    // Stopping a turn kills the thread's own processes, never its shell.
    expect(harness.core.procs.liveCount(threadId)).toBe(0);

    await client.call('terminals.write', { id, data: 'echo boite-pty-marker\r' });
    await waitFor(() => seen.text().split('boite-pty-marker').length > 2, SHELL_MS);
    await client.call('terminals.resize', { id, cols: 60, rows: 20 });

    const again = await client.call('terminals.open', { threadId, cols: 80, rows: 24 });
    expect(again.output).toContain('boite-pty-marker');

    await client.call('terminals.close', { id });
    await waitFor(() => seen.exited() !== null);
    await waitFor(() => harness.core.procs.liveCount(id) === 0);
    await expect(client.call('terminals.write', { id, data: 'x' })).rejects.toThrow(/no terminal is running/);
  }, 30_000);

  test('archiving a thread closes its shell', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const id = threadTerminalId(threadId);
    const seen = watch(client, id);
    await client.call('terminals.open', { threadId, cols: 80, rows: 24 });
    await client.call('threads.archive', { threadId });
    await waitFor(() => seen.exited() !== null, SHELL_MS);
    expect(harness.core.terminals.has(id)).toBe(false);
    await expect(client.call('terminals.open', { threadId, cols: 80, rows: 24 })).rejects.toThrow(/is archived/);
  }, 30_000);

  test('a closing shell keeps its id until it exits, and removing the project waits for it', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const { projectId } = harness.core.threads.require(threadId);
    const id = threadTerminalId(threadId);
    await client.call('terminals.open', { threadId, cols: 80, rows: 24 });
    const closed = harness.core.terminals.close(id);
    // Killed, not gone yet: no keys, and no second shell under the same id.
    expect(() => harness.core.terminals.openThread(threadId, 80, 24)).toThrow(/still closing/);
    expect(() => harness.core.terminals.write(id, 'x')).toThrow(/no terminal is running/);
    await closed;
    expect(harness.core.terminals.has(id)).toBe(false);

    await client.call('terminals.open', { threadId, cols: 80, rows: 24 });
    await client.call('projects.remove', { projectId });
    expect(harness.core.procs.liveCount(id)).toBe(0);
  }, 30_000);

  test('a terminal login types its command, and closing the shell rechecks the account', async () => {
    const client = await harness.connect();
    await addTerminalLoginProvider(harness, client);
    const account = await client.call('accounts.add', { providerId: 'echo-menu', label: 'Menu', useDefaultLocation: false });
    expect(account.status).toBe('unauthenticated');
    const id = `login:${account.id}`;
    const seen = watch(client, id);
    const updates: string[] = [];
    client.on('accounts.updated', (next) => {
      if (next.id === account.id) updates.push(next.status);
    });

    const opened = await client.call('accounts.loginTerminal', { accountId: account.id, cols: 120, rows: 30 });
    expect(opened.cwd).toBe(account.isolationDir ?? '');
    // The shell prompt comes up, the command is typed on it, the CLI prints its link.
    await waitFor(() => seen.text().includes('example.invalid/login?code=echo'), SHELL_MS);
    expect(seen.text()).toContain('echo-login.ts');
    // Attaching again is the same shell, not a second login, and no piped one starts beside it.
    expect((await client.call('accounts.loginTerminal', { accountId: account.id, cols: 100, rows: 30 })).id).toBe(id);
    await expect(client.call('accounts.login', { accountId: account.id })).rejects.toThrow(/already running/);

    await client.call('terminals.write', { id, data: 'fake-code\r' });
    await waitFor(() => existsSync(join(account.isolationDir ?? '', '.credentials.json')), SHELL_MS);
    expect(updates).toEqual([]);
    await client.call('terminals.close', { id });
    await waitFor(() => updates.includes('ok'), SHELL_MS);
  }, 40_000);

  test('a login that is not a terminal one refuses a terminal, and the shipped menu logins are', async () => {
    const client = await harness.connect();
    const accounts = await client.call('accounts.list', {});
    const echo = accounts.find((entry) => entry.providerId === 'echo');
    if (echo === undefined) throw new Error('no echo account');
    await expect(client.call('accounts.loginTerminal', { accountId: echo.id, cols: 80, rows: 24 })).rejects.toThrow(/does not sign in from a terminal/);
    const { loaded } = await client.call('providers.list', {});
    expect(loaded.find((provider) => provider.id === 'opencode')?.login).toEqual({ kind: 'terminal' });
    expect(loaded.find((provider) => provider.id === 'grok')?.login).toEqual({ kind: 'terminal' });
    expect(loaded.find((provider) => provider.id === 'codex')?.login).toEqual({ kind: 'command' });
  });

  test('a descriptor asking for a terminal without a command is refused by name', async () => {
    const client = await harness.connect();
    const dir = join(harness.dataDir, 'providers');
    mkdirSync(dir, { recursive: true });
    const profile = { detect: {}, executable: [] };
    writeFileSync(join(dir, 'bad-terminal.json'), JSON.stringify({
      id: 'bad-terminal',
      schemaVersion: 1,
      name: 'Bad',
      shortName: 'Bad',
      protocol: 'acp',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      login: { acp: { methodId: 'x' }, terminal: true },
      models: [{ id: 'x', name: 'X', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
    }), 'utf8');
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected.find((entry) => entry.file.endsWith('bad-terminal.json'))?.field).toBe('login.terminal');
  });
});

describe('shells', () => {
  test('Windows prefers PowerShell 7, then Windows PowerShell, then cmd', () => {
    const env = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    expect(pickShell('win32', env, () => 'C:\\pwsh\\pwsh.exe', () => true)).toEqual({ exe: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo'], kind: 'powershell' });
    expect(pickShell('win32', env, () => null, () => true).exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(pickShell('win32', env, () => null, () => false)).toEqual({ exe: 'C:\\Windows\\System32\\cmd.exe', args: [], kind: 'cmd' });
  });

  test('BOITE_TERMINAL_SHELL wins and names how a command is typed into it', () => {
    expect(pickShell('win32', { BOITE_TERMINAL_SHELL: 'C:\\Windows\\System32\\cmd.exe' }, () => 'C:\\pwsh\\pwsh.exe', () => true).kind).toBe('cmd');
    expect(pickShell('win32', { BOITE_TERMINAL_SHELL: 'D:\\tools\\pwsh.exe' }, () => null, () => false)).toEqual({ exe: 'D:\\tools\\pwsh.exe', args: ['-NoLogo'], kind: 'powershell' });
    expect(pickShell('linux', { BOITE_TERMINAL_SHELL: '/bin/sh', SHELL: '/usr/bin/zsh' }, () => null, () => true)).toEqual({ exe: '/bin/sh', args: [], kind: 'posix' });
  });

  test('elsewhere the user\'s $SHELL, then bash, then sh', () => {
    expect(pickShell('linux', { SHELL: '/usr/bin/zsh' }, () => null, () => true).exe).toBe('/usr/bin/zsh');
    expect(pickShell('linux', {}, () => null, (path) => path === '/bin/bash').exe).toBe('/bin/bash');
    expect(pickShell('linux', {}, () => null, () => false).exe).toBe('/bin/sh');
  });

  test('a typed command quotes what the shell would split', () => {
    expect(commandLine('powershell', ['C:\\Program Files\\op\\opencode.exe', 'auth', 'login'])).toBe("& 'C:\\Program Files\\op\\opencode.exe' auth login");
    expect(commandLine('powershell', ['opencode', 'auth', 'login'])).toBe('& opencode auth login');
    expect(commandLine('cmd', ['C:\\Program Files\\op\\opencode.exe', 'auth'])).toBe('"C:\\Program Files\\op\\opencode.exe" auth');
    expect(commandLine('posix', ['/opt/my tools/grok', "it's", '--device-auth'])).toBe("'/opt/my tools/grok' 'it'\\''s' --device-auth");
  });
});
