import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MAX_THREAD_TERMINALS, type RpcEvents } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { HISTORY_CHARS, OutputHistory, commandLine, pickShell, threadTerminalId, windowsPty } from '../src/terminals.ts';
import { HistoryAnnounce, defaultHistoryFile, integrate, parseHistory } from '../src/terminal-integration.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

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
  test.skipIf(process.platform !== 'linux')('closing a terminal stops jobs in their own process groups even when they ignore hangups', async () => {
    const id = 'terminal:stubborn-job';
    const pidFile = join(harness.dataDir, 'job.pid');
    const chosen = process.env['BOITE_TERMINAL_SHELL'];
    process.env['BOITE_TERMINAL_SHELL'] = '/bin/bash';
    let job = 0;
    const running = () => {
      try { return readFileSync(`/proc/${job}/stat`, 'utf8').split(') ')[1]!.split(' ')[0] !== 'Z'; }
      catch { return false; }
    };
    try {
      harness.core.terminals.open(id, { cwd: harness.dataDir, env: { ...process.env, HOME: harness.dataDir }, cols: 80, rows: 24 });
      // Bash job control gives this background job a group separate from the shell's.
      harness.core.terminals.write(id, `${commandLine('posix', ['/bin/sh', '-c', 'trap "" HUP TERM; echo $$ > "$1"; exec sleep 60', 'job', pidFile])} &\r`);
      // The redirection creates the file before echo writes the pid into it.
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'));
      job = Number(readFileSync(pidFile, 'utf8').trim());
      expect(job).toBeGreaterThan(0);
      expect(running()).toBe(true);
      const group = Number(readFileSync(`/proc/${job}/stat`, 'utf8').split(') ')[1]!.split(' ')[2]);
      expect(group).toBe(job);
      expect(group).not.toBe(harness.core.journal.listProcesses(id, 10)[0]!.pid);
      await harness.core.terminals.close(id);
      await waitFor(() => !running(), 3000);
    } finally {
      if (job > 0 && running()) {
        try { process.kill(job, 'SIGKILL'); }
        catch (error) {
          // The job can disappear between reading /proc and sending the signal.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await harness.core.terminals.close(id);
      if (chosen === undefined) delete process.env['BOITE_TERMINAL_SHELL'];
      else process.env['BOITE_TERMINAL_SHELL'] = chosen;
    }
  }, 15_000);

  test.skipIf(process.platform !== 'linux')('a prepared login runs before a shell profile can read its command as an answer', async () => {
    const id = 'login:profile-read';
    const result = join(harness.dataDir, 'login.answer');
    const stolen = join(harness.dataDir, 'profile.answer');
    writeFileSync(join(harness.dataDir, '.bashrc'), `printf 'profile asks: '\nread answer\nprintf '%s' "$answer" > ${commandLine('posix', [stolen])}\n`);
    const chosen = process.env['BOITE_TERMINAL_SHELL'];
    process.env['BOITE_TERMINAL_SHELL'] = '/bin/bash';
    // Opened in the core, not by a client: no socket attached it, so its output is read on the bus.
    let text = '';
    const off = harness.core.bus.onAny((name, payload) => {
      if (name === 'terminal.output' && (payload as RpcEvents['terminal.output']).id === id) text += (payload as RpcEvents['terminal.output']).data;
    });
    const seen = { text: () => text };
    try {
      harness.core.terminals.open(id, {
        cwd: harness.dataDir, env: { ...process.env, HOME: harness.dataDir }, cols: 100, rows: 24,
        type: ['/bin/sh', '-c', 'printf "login ready:%s\\n" "$1"; read reply; printf "%s" "$reply" > "$2"', 'login', 'literal & | < >', result],
      });
      await waitFor(() => seen.text().includes('login ready:literal & | < >'), 1500);
      expect(existsSync(stolen)).toBe(false);
      harness.core.terminals.write(id, 'login-answer\r');
      await waitFor(() => existsSync(result));
      expect(readFileSync(result, 'utf8')).toBe('login-answer');
      // The ordinary shell remains available once the login finishes, with its own profile.
      await waitFor(() => seen.text().includes('profile asks:'));
      harness.core.terminals.write(id, 'profile-answer\r');
      await waitFor(() => existsSync(stolen));
      expect(readFileSync(stolen, 'utf8')).toBe('profile-answer');
    } finally {
      off();
      await harness.core.terminals.close(id);
      if (chosen === undefined) delete process.env['BOITE_TERMINAL_SHELL'];
      else process.env['BOITE_TERMINAL_SHELL'] = chosen;
    }
  }, 15_000);

  test('the output of a shell reaches only the windows that attached it, and its exit every window', async () => {
    const watching = await harness.connect();
    const other = await harness.connect();
    const { threadId } = await echoThread(harness, watching);
    const id = threadTerminalId(threadId);
    const seen = watch(watching, id);
    const elsewhere = watch(other, id);
    let stray = 0;
    other.on('terminal.output', () => { stray++; });
    await watching.call('terminals.open', { threadId, cols: 80, rows: 24 });
    await watching.call('terminals.write', { id, data: 'echo only-here\r' });
    await waitFor(() => seen.text().includes('only-here\r\n'), SHELL_MS);
    await watching.call('terminals.close', { id });
    await waitFor(() => elsewhere.exited() !== null && seen.exited() !== null);
    expect(stray).toBe(0);

    // A socket that closed watches nothing: the next window to attach the id is the only one that hears it.
    await other.call('terminals.open', { threadId, cols: 80, rows: 24 });
    watching.close();
    await other.call('terminals.write', { id, data: 'echo now-here\r' });
    await waitFor(() => elsewhere.text().includes('now-here\r\n'), SHELL_MS);
    await other.call('terminals.close', { id });
  }, 30_000);

  test('a thread shell runs in its working directory, takes keys, resizes, reattaches and closes', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const id = threadTerminalId(threadId);
    const seen = watch(client, id);

    expect(await thrown(client.call('terminals.open', { threadId, cols: 0, rows: 24 }))).toThrow(/cols must be an integer/);
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
    expect(await thrown(client.call('terminals.write', { id, data: 'x' }))).toThrow(/no terminal is running/);
  }, 30_000);

  test('a burst of output goes out in fewer events than chunks, and a snapshot is exactly what went out', async () => {
    const procs = harness.core.procs;
    const spawn = procs.spawnTerminal.bind(procs);
    let chunks = 0;
    const spy = spyOn(procs, 'spawnTerminal').mockImplementation((threadId, cmd, args, opts) => spawn(threadId, cmd, args, {
      ...opts,
      onData: (bytes) => {
        // PTY reads vary by OS and runner load. Deliver the real bytes in
        // small chunks so this always exercises the output batching.
        for (let at = 0; at < bytes.length; at += 64) {
          chunks += 1;
          opts.onData(bytes.subarray(at, at + 64));
        }
      },
    }));
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client);
      const id = threadTerminalId(threadId);
      let events = 0;
      let text = '';
      client.on('terminal.output', (event) => {
        if (event.id !== id) return;
        events += 1;
        text += event.data;
      });
      await client.call('terminals.open', { threadId, cols: 100, rows: 30 });
      const burst = process.platform === 'win32' ? 'for /L %i in (1,1,3000) do @echo burst-%i\r' : 'i=0; while [ $i -lt 3000 ]; do i=$((i+1)); echo burst-$i; done\r';
      await client.call('terminals.write', { id, data: burst });
      await waitFor(() => text.includes('burst-3000'), SHELL_MS);
      // The trailing prompt lands after the last line: wait for the stream to settle.
      for (let seen = -1; seen !== text.length;) {
        seen = text.length;
        await Bun.sleep(150);
      }
      expect(chunks).toBeGreaterThan(20);
      expect(events).toBeLessThan(chunks / 2);
      const again = await client.call('terminals.open', { threadId, cols: 100, rows: 30 });
      expect(again.output).toBe(text.slice(-HISTORY_CHARS));
      expect(again.sequence).toBe(events);
    } finally {
      spy.mockRestore();
    }
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
    expect(await thrown(client.call('terminals.open', { threadId, cols: 80, rows: 24 }))).toThrow(/is archived/);
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
    await client.call('projects.remove', { projectId: projectId! });
    expect(harness.core.procs.liveCount(id)).toBe(0);
  }, 30_000);

  test('a thread runs several shells side by side, lists them in order, and closing one leaves the others', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const first = threadTerminalId(threadId);
    const second = threadTerminalId(threadId, 'term-2');
    const third = threadTerminalId(threadId, 'term-3');
    expect(await thrown(client.call('terminals.open', { threadId, cols: 80, rows: 24, terminalId: 'Bad id' }))).toThrow(/terminalId must be/);
    await client.call('terminals.open', { threadId, cols: 80, rows: 24 });
    const opened = await client.call('terminals.open', { threadId, cols: 80, rows: 24, terminalId: 'term-2' });
    expect(opened.id).toBe(second);
    await client.call('terminals.open', { threadId, cols: 80, rows: 24, terminalId: 'term-3' });
    const cwd = harness.core.threads.require(threadId).cwd;
    expect(await client.call('terminals.list', { threadId })).toEqual([
      { id: first, cwd },
      { id: second, terminalId: 'term-2', cwd },
      { id: third, terminalId: 'term-3', cwd },
    ]);
    // Each shell is its own process tree: closing a tab kills that one only.
    for (const id of [first, second, third]) expect(harness.core.procs.liveCount(id)).toBeGreaterThan(0);
    const seen = watch(client, second);
    await client.call('terminals.write', { id: second, data: 'echo second-pty-marker\r' });
    await waitFor(() => seen.text().split('second-pty-marker').length > 2, SHELL_MS);
    await client.call('terminals.close', { id: second });
    await waitFor(() => harness.core.procs.liveCount(second) === 0);
    expect(harness.core.procs.liveCount(first)).toBeGreaterThan(0);
    expect(harness.core.procs.liveCount(third)).toBeGreaterThan(0);
    expect((await client.call('terminals.list', { threadId })).map((shell) => shell.id)).toEqual([first, third]);
    // Opening an id that runs attaches to it, with what it printed.
    const third2 = await client.call('terminals.open', { threadId, cols: 90, rows: 30, terminalId: 'term-3' });
    expect(third2.id).toBe(third);

    await client.call('threads.archive', { threadId });
    await waitFor(() => harness.core.procs.liveCount(first) + harness.core.procs.liveCount(third) === 0, SHELL_MS);
    expect(await client.call('terminals.list', { threadId })).toEqual([]);
  }, 30_000);

  test('a thread holds at most MAX_THREAD_TERMINALS shells, named term-2 to term-16', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const spawn = spyOn(harness.core.procs, 'spawnTerminal');
    // Sixteen of the lightest shell there is, not sixteen of the user's.
    const chosen = process.env['BOITE_TERMINAL_SHELL'];
    process.env['BOITE_TERMINAL_SHELL'] = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    try {
      for (let i = 1; i <= MAX_THREAD_TERMINALS; i++) {
        harness.core.terminals.openThread(threadId, 80, 24, i === 1 ? undefined : `term-${i}`);
      }
      // No other name opens a seventeenth, nor one a client would number 0.
      for (const name of ['term-17', 'term-1', 'term-02', 'foo']) {
        expect(() => harness.core.terminals.openThread(threadId, 80, 24, name)).toThrow(/terminalId must be term-2 to term-16/);
      }
      // Reattaching to a running one is no new shell.
      expect(harness.core.terminals.openThread(threadId, 80, 24, 'term-3').id).toBe(threadTerminalId(threadId, 'term-3'));
      expect(spawn).toHaveBeenCalledTimes(MAX_THREAD_TERMINALS);
    } finally {
      spawn.mockRestore();
      if (chosen === undefined) delete process.env['BOITE_TERMINAL_SHELL'];
      else process.env['BOITE_TERMINAL_SHELL'] = chosen;
    }
  }, 60_000);

  test('a thread\'s bash or PowerShell marks each prompt and command, reports its directory, and lists what ran in its history', async () => {
    // A home and a history file of the test's own: bash reads no ~/.bashrc of the user's,
    // and neither shell writes to the user's history. PowerShell still loads the user's profile.
    const pwsh = process.platform === 'win32' ? Bun.which('pwsh.exe') : null;
    if (process.platform === 'win32' && pwsh === null) return;
    // macOS ships bash 3.2, which has no PS0 and so never marks a command running;
    // its users get zsh or a login bash, which start without the integration.
    if (process.platform === 'darwin') return;
    const home = mkdtempSync(join(tmpdir(), 'boite-shell-home-'));
    const saved = { shell: process.env['BOITE_TERMINAL_SHELL'], home: process.env['HOME'], history: process.env['BOITE_TERMINAL_HISTORY'], histfile: process.env['HISTFILE'] };
    process.env['BOITE_TERMINAL_SHELL'] = pwsh ?? '/bin/bash';
    process.env['HOME'] = home;
    // PSReadLine ignores APPDATA: without this it would save to the user's own history.
    process.env['BOITE_TERMINAL_HISTORY'] = join(home, 'ConsoleHost_history.txt');
    delete process.env['HISTFILE'];
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client);
      const id = threadTerminalId(threadId);
      const seen = watch(client, id);
      const opened = await client.call('terminals.open', { threadId, cols: 100, rows: 30 });
      expect(opened.shell).toEqual({ name: pwsh === null ? 'bash' : 'pwsh', kind: pwsh === null ? 'posix' : 'powershell', integrated: true });
      await waitFor(() => seen.text().includes('\x1b]133;B'), SHELL_MS);
      expect(seen.text()).toContain('\x1b]133;A');
      // The shell reports the directory it resolved: macOS's /var is /private/var, and a
      // Windows runner's RUNNER~1 is runneradmin. Either form names the same folder.
      const forms = [opened.cwd, realpathSync.native(opened.cwd)];
      if (!forms.some((form) => seen.text().includes(`\x1b]633;P;Cwd=${form}`))) {
        throw new Error(`expected Cwd to be one of ${forms.join(', ')} in ${JSON.stringify(seen.text().slice(-2000))}`);
      }

      // A failing command: C as it runs, then D with its status before the next prompt.
      const failing = pwsh === null ? 'ls /boite-missing-path' : 'cmd /c exit 3';
      // PSReadLine colours the typed line, so the output is cut where the typing began.
      const typedAt = seen.text().length;
      await client.call('terminals.write', { id, data: `${failing}\r` });
      await waitFor(() => /\x1b\]133;D;[1-9]/.test(seen.text().slice(typedAt)), SHELL_MS);
      const after = seen.text().slice(typedAt);
      expect(after.indexOf('\x1b]133;C')).toBeGreaterThan(-1);
      expect(after.indexOf('\x1b]133;C')).toBeLessThan(after.indexOf('\x1b]133;D;'));
      if (pwsh !== null) expect(after).toContain('\x1b]133;D;3');

      const echoedAt = seen.text().length;
      await client.call('terminals.write', { id, data: 'echo boite-history-marker\r' });
      // The next prompt's input mark comes after bash's `history -a`: the command is in the file by then.
      await waitFor(() => /\x1b\]133;D;0[\s\S]*\x1b\]133;B/.test(seen.text().slice(echoedAt)), SHELL_MS);
      // Written as each command ran, not when the shell exits. PSReadLine saves on its own
      // schedule, so the list is asked again until the command is in it.
      let commands: string[] = [];
      const until = Date.now() + SHELL_MS;
      while (Date.now() < until && commands[0] !== 'echo boite-history-marker') {
        commands = (await client.call('terminals.history', { id })).commands;
        if (commands[0] !== 'echo boite-history-marker') await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Exactly the two commands: the shell read and wrote the test's own file, nothing of the user's.
      expect(commands).toEqual(['echo boite-history-marker', failing]);
      await client.call('terminals.close', { id });
      await waitFor(() => seen.exited() !== null, SHELL_MS);
    } finally {
      for (const [name, value] of [['BOITE_TERMINAL_SHELL', saved.shell], ['HOME', saved.home], ['BOITE_TERMINAL_HISTORY', saved.history], ['HISTFILE', saved.histfile]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('cmd or sh starts without the integration, and its history is empty', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const opened = await client.call('terminals.open', { threadId, cols: 80, rows: 24 });
    expect(opened.shell?.integrated).toBe(false);
    expect((await client.call('terminals.history', { id: opened.id })).commands).toEqual([]);
    await client.call('terminals.close', { id: opened.id });
  }, 30_000);

  test('removing a thread stops every one of its shells and drops their process records', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const ids = [threadTerminalId(threadId), threadTerminalId(threadId, 'term-2')];
    await client.call('terminals.open', { threadId, cols: 80, rows: 24 });
    await client.call('terminals.open', { threadId, cols: 80, rows: 24, terminalId: 'term-2' });
    const other = (await echoThread(harness, client)).threadId;
    await client.call('terminals.open', { threadId: other, cols: 80, rows: 24 });
    const records = (id: string) => (harness.core.journal.db.query("SELECT COUNT(*) AS n FROM processes WHERE thread_id LIKE 'terminal:' || ? || '%'").get(id) as { n: number }).n;
    await waitFor(() => records(threadId) >= 2 && records(other) >= 1);
    await client.call('threads.remove', { threadId });
    for (const id of ids) expect(harness.core.procs.liveCount(id)).toBe(0);
    // The records go with the conversation's history, once its retention ends.
    harness.core.journal.deleteThreads([threadId]);
    expect(records(threadId)).toBe(0);
    expect(records(other)).toBeGreaterThan(0);
  }, 30_000);

  test('a terminal login runs its command, and closing the shell rechecks the account', async () => {
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
    // The login starts in the PTY, and its CLI prints the sign-in link.
    await waitFor(() => seen.text().includes('example.invalid/login?code=echo'), SHELL_MS);
    if (process.platform === 'win32') expect(seen.text()).toContain('echo-login.ts');
    else expect(harness.core.journal.listProcesses(id, 10)[0]?.commandLine).toContain('echo-login.ts');
    // Attaching again is the same shell, not a second login, and no piped one starts beside it.
    expect((await client.call('accounts.loginTerminal', { accountId: account.id, cols: 100, rows: 30 })).id).toBe(id);
    expect(await thrown(client.call('accounts.login', { accountId: account.id }))).toThrow(/already running/);

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
    expect(await thrown(client.call('accounts.loginTerminal', { accountId: echo.id, cols: 80, rows: 24 }))).toThrow(/does not sign in from a terminal/);
    const { loaded } = await client.call('providers.list', {});
    expect(loaded.find((provider) => provider.id === 'opencode')?.login).toEqual({ kind: 'terminal' });
    expect(loaded.find((provider) => provider.id === 'grok')?.login).toEqual({ kind: 'terminal' });
    expect(loaded.find((provider) => provider.id === 'codex')?.login).toEqual({ kind: 'device' });
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

describe('output history', () => {
  test('ten megabytes in small chunks keep exactly the last window, without copying it per chunk', () => {
    // Making the chunks is the yardstick: a runner slow at one is slow at the other.
    let started = performance.now();
    const chunks = Array.from({ length: 160_000 }, (_, index) => `${String(index).padStart(8, '0')}${'x'.repeat(55)}\n`);
    const making = performance.now() - started;
    const history = new OutputHistory();
    started = performance.now();
    for (const chunk of chunks) history.push(chunk);
    const pushing = performance.now() - started;
    const text = history.text();
    expect(text.length).toBe(HISTORY_CHARS);
    expect(text).toBe(chunks.slice(-5000).join('').slice(-HISTORY_CHARS));
    // Keeping them costs about half of making them. The old append-and-slice
    // copied 256 KB per chunk: 800 ms, 50 to 60 times the making (2026-09-28,
    // Ryzen 7 9800X3D). The bound stretches on a runner slow at both.
    expect(pushing).toBeLessThan(Math.max(500, making * 10));
  });

  test('a chunk larger than the window keeps its tail', () => {
    const history = new OutputHistory(10);
    history.push('abc');
    history.push('0123456789ABCDEF');
    expect(history.text()).toBe('6789ABCDEF');
    history.push('xy');
    expect(history.text()).toBe('89ABCDEFxy');
  });

  test('a cut window starts on a whole line, never inside an escape sequence', () => {
    const history = new OutputHistory(12);
    history.push('first\x1b[31mred\x1b[0m\nsecond\n');
    // The last 12 characters start at `1b[0m`: half of the sequence that reset the colour.
    expect(history.text()).toBe('second\n');
  });
});

describe('shells', () => {
  test('a ConPTY shell tells the emulator its Windows build, and no other shell says anything', () => {
    expect(windowsPty('win32', '10.0.26100')).toEqual({ windowsPty: { buildNumber: 26100 } });
    expect(windowsPty('win32', 'unknown')).toEqual({});
    expect(windowsPty('linux', '6.8.0-45-generic')).toEqual({});
  });

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
    expect(pickShell('linux', { SHELL: '/usr/bin/zsh' }, () => null, () => true).args).toEqual([]);
    // Homebrew's PATH lives in ~/.zprofile, which only a login shell reads.
    expect(pickShell('darwin', { SHELL: '/bin/zsh' }, () => null, () => true)).toEqual({ exe: '/bin/zsh', args: ['-l'], kind: 'posix' });
  });

  test('a typed command quotes what the shell would split', () => {
    expect(commandLine('powershell', ['C:\\Program Files\\op\\opencode.exe', 'auth', 'login'])).toBe("& 'C:\\Program Files\\op\\opencode.exe' auth login");
    expect(commandLine('powershell', ['opencode', 'auth', 'login'])).toBe('& opencode auth login');
    expect(commandLine('cmd', ['C:\\Program Files\\op\\opencode.exe', 'auth'])).toBe('"C:\\Program Files\\op\\opencode.exe" auth');
    expect(commandLine('posix', ['/opt/my tools/grok', "it's", '--device-auth'])).toBe("'/opt/my tools/grok' 'it'\\''s' --device-auth");
  });
});

describe('shell integration', () => {
  test('bash and PowerShell get it; cmd, sh, zsh, a login bash and the opt-out do not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boite-integration-'));
    try {
      const bash = integrate({ exe: '/bin/bash', args: [], kind: 'posix' }, dir, 'linux', {});
      expect(bash.integrated).toBe(true);
      expect(bash.shell.args).toEqual(['--rcfile', join(dir, 'shell-integration', 'boite.bash'), '-i']);
      expect(existsSync(join(dir, 'shell-integration', 'boite.bash'))).toBe(true);
      // A second shell finds the same file and leaves no half-written copy behind.
      integrate({ exe: '/bin/bash', args: [], kind: 'posix' }, dir, 'linux', {});
      expect(readdirSync(join(dir, 'shell-integration'))).toEqual(['boite.bash']);
      const pwsh = integrate({ exe: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo'], kind: 'powershell' }, dir, 'win32', {});
      expect(pwsh.shell.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
      expect(Buffer.from(pwsh.shell.args[3]!, 'base64').toString('utf16le')).toContain('133;C');
      for (const shell of [
        { exe: 'C:\\Windows\\System32\\cmd.exe', args: [], kind: 'cmd' as const },
        { exe: '/bin/sh', args: [], kind: 'posix' as const },
        { exe: '/bin/zsh', args: [], kind: 'posix' as const },
        { exe: '/bin/bash', args: ['-l'], kind: 'posix' as const },
      ]) {
        expect(integrate(shell, dir, 'linux', {})).toEqual({ shell, integrated: false });
      }
      expect(integrate({ exe: '/bin/bash', args: [], kind: 'posix' }, dir, 'linux', { BOITE_TERMINAL_INTEGRATION: '0' }).integrated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a history file reads newest first, each command once, PowerShell continuations and bash timestamps included', () => {
    expect(parseHistory('git status\r\nls\r\nGet-ChildItem |`\r\n  Select Name\r\ngit status\r\n', 'powershell')).toEqual(['git status', 'Get-ChildItem |\n  Select Name', 'ls']);
    // The user's own continuation backtick is saved doubled and keeps one, as PSReadLine recalls it.
    expect(parseHistory('Get-Item x ``\r\n  -Force\r\n', 'powershell')).toEqual(['Get-Item x `\n  -Force']);
    expect(parseHistory('#1700000000\nmake\n#1700000001\ncd src\n\nmake\n', 'posix')).toEqual(['make', 'cd src']);
    expect(parseHistory(Array.from({ length: 900 }, (_, i) => `cmd ${i}`).join('\n'), 'posix')).toHaveLength(500);
  });

  test('the history file the integration names is found across chunk boundaries, else the shell\'s default', () => {
    const announce = new HistoryAnnounce();
    announce.feed('prompt\x1b]633;P;History');
    announce.feed('File=/home/u/.bash_history\x07$ ');
    expect(announce.path).toBe('/home/u/.bash_history');
    expect(defaultHistoryFile({ name: 'pwsh', kind: 'powershell', integrated: true }, 'win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt');
    expect(defaultHistoryFile({ name: 'bash', kind: 'posix', integrated: true }, 'linux', {}, '/home/u')).toBe('/home/u/.bash_history');
    expect(defaultHistoryFile({ name: 'sh', kind: 'posix', integrated: false }, 'linux', {}, '/home/u')).toBeNull();
  });
});
