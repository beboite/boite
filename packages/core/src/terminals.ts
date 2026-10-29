/*
 * Shells in a pseudo-terminal. A thread has up to `MAX_THREAD_TERMINALS`,
 * opened under the chat with Ctrl+J in the thread's working directory, and an
 * account whose CLI signs in through an interactive menu gets one with its
 * login command started in it. Each shell goes through `procs.spawnTerminal` under
 * its own trace id, never the thread's: stopping a turn must not take the
 * user's shell with it, and closing one tab must not take the others.
 */

import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { win32 } from 'node:path';
import { MAX_THREAD_TERMINALS, THREAD_TERMINAL_KEY, isThreadTerminal, threadTerminalId } from '@boite/contracts';
import type { TerminalShell, TerminalState, ThreadId, ThreadTerminal } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, notFound, refused } from './errors.ts';
import type { Router } from './router.ts';
import { HistoryAnnounce, defaultHistoryFile, describeShell, integrate, parseHistory, readHistoryTail } from './terminal-integration.ts';

/** What a late client is sent to redraw the screen. A full-screen app redraws itself anyway. */
export const HISTORY_CHARS = 256 * 1024;
/**
 * Output that follows other output within this window goes out as one event. The
 * first chunk after a quiet window goes at once, so a typed key echoes without delay.
 */
export const OUTPUT_WINDOW_MS = 16;
/** How far into a cut history the first line break is looked for. */
const LINE_SEARCH_CHARS = 4096;
/** Chunks the history holds before it joins them into one string. */
const HISTORY_CHUNKS = 4096;
/** The shell prints its prompt, then goes quiet: that is when a typed command lands on it. */
const PROMPT_QUIET_MS = 250;
/** A shell that never goes quiet still gets the command. */
const PROMPT_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;

/**
 * What the emulator needs to know about ConPTY: the third number of `10.0.26100`.
 * Nothing elsewhere, and nothing when the release does not read that way.
 */
export function windowsPty(
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): Pick<TerminalState, 'windowsPty'> {
  if (platform !== 'win32') return {};
  const buildNumber = Number(osRelease.split('.')[2]);
  return Number.isInteger(buildNumber) && buildNumber > 0 ? { windowsPty: { buildNumber } } : {};
}

export { threadTerminalId };

export interface Shell {
  exe: string;
  args: string[];
  kind: 'powershell' | 'cmd' | 'posix';
}

/**
 * `BOITE_TERMINAL_SHELL` when set, else PowerShell 7 when it is on the PATH,
 * the Windows PowerShell every Windows has, then cmd. `$SHELL` elsewhere, then
 * bash, then sh. On macOS a login shell, as Terminal.app starts: zsh reads
 * `/etc/zprofile` and `~/.zprofile` only then, and that is where Homebrew and
 * most version managers put their PATH.
 */
export function pickShell(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  which: (name: string) => string | null = (name) => Bun.which(name),
  exists: (path: string) => boolean = existsSync,
): Shell {
  const chosen = env['BOITE_TERMINAL_SHELL'];
  if (chosen !== undefined && chosen.length > 0) {
    const name = (platform === 'win32' ? win32.basename(chosen) : chosen.split('/').pop() ?? chosen).toLowerCase();
    if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return { exe: chosen, args: ['-NoLogo'], kind: 'powershell' };
    return { exe: chosen, args: [], kind: /^cmd(\.exe)?$/.test(name) ? 'cmd' : 'posix' };
  }
  if (platform === 'win32') {
    const pwsh = which('pwsh.exe');
    if (pwsh !== null) return { exe: pwsh, args: ['-NoLogo'], kind: 'powershell' };
    const root = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows';
    const windowsPowerShell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(windowsPowerShell)) return { exe: windowsPowerShell, args: ['-NoLogo'], kind: 'powershell' };
    return { exe: env['ComSpec'] ?? win32.join(root, 'System32', 'cmd.exe'), args: [], kind: 'cmd' };
  }
  const args = platform === 'darwin' ? ['-l'] : [];
  const named = env['SHELL'];
  if (named !== undefined && named.length > 0 && exists(named)) return { exe: named, args, kind: 'posix' };
  return { exe: exists('/bin/bash') ? '/bin/bash' : '/bin/sh', args, kind: 'posix' };
}

/** The line a user would type to run `argv` in this shell, quoted where it has to be. */
export function commandLine(kind: Shell['kind'], argv: string[]): string {
  if (kind === 'powershell') {
    // The call operator runs a quoted path, which PowerShell would print as a string.
    return `& ${argv.map((part) => (/^[\w.:\\/-]+$/.test(part) ? part : `'${part.replaceAll("'", "''")}'`)).join(' ')}`;
  }
  if (kind === 'cmd') return argv.map((part) => (/^[\w.:\\/-]+$/.test(part) ? part : `"${part}"`)).join(' ');
  return argv.map((part) => (/^[\w.:/=@-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`)).join(' ');
}

/**
 * The last `max` characters of a stream, kept as the chunks that came in. A busy
 * shell prints tens of thousands of small chunks: appending each to one 256 KB
 * string and slicing it again copied the whole history per chunk.
 */
export class OutputHistory {
  #chunks: string[] = [];
  private length = 0;

  constructor(private readonly max = HISTORY_CHARS) {}

  push(data: string): void {
    this.#chunks.push(data);
    this.length += data.length;
    // Drop whole chunks while what is left still covers the window.
    while (this.#chunks.length > 1 && this.length - this.#chunks[0]!.length >= this.max) {
      this.length -= this.#chunks.shift()!.length;
    }
    if (this.#chunks.length > HISTORY_CHUNKS) {
      const joined = this.text();
      this.#chunks = [joined];
      this.length = joined.length;
    }
  }

  /**
   * A cut window starts on a line of its own: the cut can land inside an
   * escape sequence, and the half that is left draws as stray characters at
   * the top of the screen a client redraws.
   */
  text(): string {
    const all = this.#chunks.join('');
    if (all.length <= this.max) return all;
    const cut = all.slice(-this.max);
    const line = cut.indexOf('\n');
    return line === -1 || line > LINE_SEARCH_CHARS ? cut : cut.slice(line + 1);
  }
}

interface Session {
  id: string;
  cwd: string;
  terminal: Bun.Terminal;
  sequence: number;
  /** Exactly what `terminal.output` events carried so far, so a snapshot and the events after it never overlap. */
  history: OutputHistory;
  exited: Promise<number | null>;
  /** Killed, not gone yet: it takes no keys, and its id is not free for a new shell. */
  closing: boolean;
  shell: TerminalShell;
  /** The history file the shell's integration named, else its default. */
  historyFile: () => string | null;
}

export interface StartOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  /** A login command started before the POSIX shell, or typed at its Windows prompt. */
  type?: string[];
  onExit?: () => void;
  /** The thread a thread's shell belongs to, set on its log records. */
  threadId?: ThreadId;
  /** Start bash or PowerShell with the shell integration: a thread's shell, never a login one. */
  integrate?: boolean;
}

export class TerminalStore {
  readonly #sessions = new Map<string, Session>();
  /**
   * The connections that attached each shell: `terminal.output` goes to them
   * only. A window without that pane would drop the bytes anyway.
   */
  readonly #watchers = new Map<string, Set<string>>();

  readonly #core: Core;

  constructor(core: Core) {
    this.#core = core;}

  /** The connection attached shell `id`: from now on its output reaches it. */
  watch(id: string, connectionId: string): void {
    const watching = this.#watchers.get(id);
    if (watching === undefined) this.#watchers.set(id, new Set([connectionId]));
    else watching.add(connectionId);
  }

  watches(id: string, connectionId: string): boolean {
    return this.#watchers.get(id)?.has(connectionId) === true;
  }

  /** The connection let go of shell `id`. */
  unwatch(id: string, connectionId: string): void {
    const watching = this.#watchers.get(id);
    watching?.delete(connectionId);
    if (watching?.size === 0) this.#watchers.delete(id);
  }

  /**
   * The `terminal.exited` of shell `id` went out, after every line it printed:
   * nobody watches it any more, unless a shell of the same id started since.
   */
  exitSent(id: string): void {
    if (!this.#sessions.has(id)) this.#watchers.delete(id);
  }

  /** The socket closed: it watches nothing any more. */
  disconnect(connectionId: string): void {
    for (const id of [...this.#watchers.keys()]) this.unwatch(id, connectionId);
  }

  /** One of the thread's shells, started in its working directory the first time. */
  openThread(threadId: ThreadId, cols: number, rows: number, terminalId?: string): TerminalState {
    if (terminalId !== undefined && (typeof terminalId !== 'string' || !THREAD_TERMINAL_KEY.test(terminalId))) {
      throw invalidParams(`terminalId must be term-2 to term-${MAX_THREAD_TERMINALS}, not ${JSON.stringify(terminalId)}`, { field: 'terminalId', expected: `term-2 to term-${MAX_THREAD_TERMINALS}` });
    }
    const thread = this.#core.threads.require(threadId);
    if (thread.archived) throw refused(`the thread ${threadId} is archived`, { threadId, field: 'archived', expected: false });
    // The ids bound the count: the first shell and `term-2` to `term-16`.
    const id = threadTerminalId(threadId, terminalId);
    return this.open(id, { cwd: thread.cwd, env: { ...process.env }, cols, rows, threadId, integrate: true });
  }

  /** The thread's running shells, in the order they started. A closing one is gone already. */
  listThread(threadId: ThreadId): ThreadTerminal[] {
    const first = threadTerminalId(threadId);
    return this.#threadSessions(threadId).filter((session) => !session.closing).map((session) => ({
      id: session.id,
      ...(session.id === first ? {} : { terminalId: session.id.slice(first.length + 1) }),
      cwd: session.cwd,
    }));
  }

  /** Closes every shell of the thread. */
  async closeThread(threadId: ThreadId): Promise<void> {
    await Promise.all(this.#threadSessions(threadId).map((session) => this.close(session.id)));
  }

  /**
   * Kills every shell of the thread and waits for its processes to be gone, a
   * leftover whose session went already included: the records go next.
   */
  async stopThread(threadId: ThreadId): Promise<void> {
    const ids = new Set([...this.#threadSessions(threadId).map((session) => session.id), ...this.#core.procs.liveThreads().filter((id) => isThreadTerminal(threadId, id))]);
    await Promise.all([...ids].map((id) => this.#core.procs.stopAndWait(id as ThreadId)));
  }

  /** How many processes the thread's shells run. */
  threadProcesses(threadId: ThreadId): number {
    return this.#core.procs.liveThreads().filter((id) => isThreadTerminal(threadId, id)).reduce((sum, id) => sum + this.#core.procs.liveCount(id), 0);
  }

  #threadSessions(threadId: ThreadId): Session[] {
    return [...this.#sessions.values()].filter((session) => isThreadTerminal(threadId, session.id));
  }

  /** The running shell under this id, resized to the client that attaches, or a new one. */
  open(id: string, options: StartOptions): TerminalState {
    checkSize(options.cols, options.rows);
    const running = this.#sessions.get(id);
    if (running !== undefined) {
      if (running.closing) throw refused(`the shell ${id} is still closing, open it again in a moment`, { id });
      running.terminal.resize(options.cols, options.rows);
      return { id, cwd: running.cwd, output: running.history.text(), sequence: running.sequence, shell: running.shell, ...windowsPty() };
    }
    if (!existsSync(options.cwd)) {
      throw refused(`the working directory ${options.cwd} does not exist any more`, { id, cwd: options.cwd });
    }
    const picked = pickShell();
    const { shell, integrated } = options.integrate === true ? integrate(picked, this.#core.dataDir) : { shell: picked, integrated: false };
    const described = describeShell(shell, integrated);
    const announce = integrated ? new HistoryAnnounce() : null;
    const decoder = new TextDecoder();
    let session: Session | null = null;
    let sequence = 0;
    // POSIX logins run as startup argv before opening the user's shell. A
    // quiet profile may still be reading stdin, so PTY keystrokes cannot start them safely.
    const prepared = process.platform !== 'win32' && options.type !== undefined;
    const launch = prepared ? {
      exe: '/bin/sh',
      args: ['-c', `"$@"\nexec ${commandLine('posix', [shell.exe, ...shell.args])}`, 'boite-login', ...(options.type ?? [])],
    } : shell;
    let typed = options.type === undefined || prepared;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const typeNow = () => {
      if (typed || session === null) return;
      typed = true;
      if (quiet !== null) clearTimeout(quiet);
      clearTimeout(fallback);
      session.terminal.write(`${commandLine(shell.kind, options.type ?? [])}\r`);
    };
    const fallback = setTimeout(typeNow, PROMPT_TIMEOUT_MS);
    if (typed) clearTimeout(fallback);
    const env = { ...options.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const history = new OutputHistory();
    let held = '';
    let gate: ReturnType<typeof setTimeout> | null = null;
    const emit = (data: string) => {
      // A value split across two chunks passes; one whole in a chunk is masked (docs/secrets.md).
      if (options.threadId !== undefined) data = this.#core.secrets.mask(options.threadId, data);
      history.push(data);
      sequence++;
      if (session) session.sequence = sequence;
      this.#core.bus.emit('terminal.output', { id, data, sequence });
    };
    const release = () => {
      if (held.length === 0) {
        gate = null;
        return;
      }
      const data = held;
      held = '';
      emit(data);
      gate = setTimeout(release, OUTPUT_WINDOW_MS);
    };
    let spawned;
    try {
      spawned = this.#core.procs.spawnTerminal(id, launch.exe, launch.args, {
        cwd: options.cwd,
        env,
        cols: options.cols,
        rows: options.rows,
        onData: (bytes) => {
          const data = decoder.decode(bytes, { stream: true });
          if (data.length === 0) return;
          announce?.feed(data);
          if (gate === null) {
            emit(data);
            gate = setTimeout(release, OUTPUT_WINDOW_MS);
          } else held += data;
          if (!typed) {
            if (quiet !== null) clearTimeout(quiet);
            quiet = setTimeout(typeNow, PROMPT_QUIET_MS);
          }
        },
      });
    } catch (error) {
      clearTimeout(fallback);
      throw refused(`the shell ${launch.exe} did not start: ${messageOf(error)}`, { id, shell: launch.exe });
    }
    const openedAt = Date.now();
    const shellName = shell.exe.split(/[\\/]/).pop() ?? 'shell';
    const owner = options.threadId === undefined ? {} : { threadId: options.threadId };
    this.#core.logs.info(`Terminal ${id} opened with ${shellName}`, { source: 'terminals', event: 'terminal.opened', ...owner, data: { id, shell: shellName } });
    const exited = spawned.exited.then(
      (code) => code,
      () => null,
    ).then((code) => {
      // A shell exits with its last command's status: a failed `false; exit` is a routine close.
      this.#core.logs.info(`Terminal ${id} (${shellName}) exited with code ${code ?? 'unknown'} after ${Math.round((Date.now() - openedAt) / 1000)} s`, {
        source: 'terminals', event: 'terminal.exited', ...owner, durationMs: Date.now() - openedAt, data: { id, shell: shellName, exitCode: code },
      });
      clearTimeout(fallback);
      if (quiet !== null) clearTimeout(quiet);
      if (gate !== null) clearTimeout(gate);
      gate = null;
      if (this.#sessions.get(id) === session) this.#sessions.delete(id);
      if (!this.#core.journal.isClosed()) {
        // The last lines a shell printed go out before its exit, never after.
        if (held.length > 0) emit(held);
        held = '';
        this.#core.bus.emit('terminal.exited', { id, exitCode: code });
      }
      options.onExit?.();
      return code;
    });
    session = {
      id, cwd: options.cwd, terminal: spawned.terminal, sequence, history, exited, closing: false, shell: described,
      historyFile: () => announce?.path ?? defaultHistoryFile(described, process.platform, options.env),
    };
    this.#sessions.set(id, session);
    return { id, cwd: options.cwd, output: history.text(), sequence, shell: described, ...windowsPty() };
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  write(id: string, data: string): { ok: true } {
    this.require(id).terminal.write(data);
    return { ok: true };
  }

  resize(id: string, cols: number, rows: number): { ok: true } {
    checkSize(cols, rows);
    this.require(id).terminal.resize(cols, rows);
    return { ok: true };
  }

  /**
   * Kills the shell with everything it started, and waits for it to be gone.
   * The session stops taking keys at once, even when the exit is slow, and
   * keeps its id until the exit so a new shell never shares it.
   */
  async close(id: string): Promise<{ ok: true }> {
    const session = this.#sessions.get(id);
    if (session === undefined) return { ok: true };
    session.closing = true;
    this.#core.procs.killTree(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    return { ok: true };
  }

  /** The shell's recent commands, newest first, from the file its integration named or its default one. */
  history(id: string): { commands: string[] } {
    const session = this.require(id);
    const file = session.historyFile();
    if (file === null) return { commands: [] };
    const text = readHistoryTail(file);
    return { commands: text === null ? [] : parseHistory(text, session.shell.kind) };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }

  private require(id: string): Session {
    const session = this.#sessions.get(id);
    if (session === undefined || session.closing) throw notFound(`no terminal is running as ${id}`, { id });
    return session;
  }
}

function checkSize(cols: unknown, rows: unknown): void {
  if (!Number.isInteger(cols) || (cols as number) < 2 || (cols as number) > 1000) {
    throw invalidParams('cols must be an integer from 2 to 1000', { field: 'cols', expected: '2..1000' });
  }
  if (!Number.isInteger(rows) || (rows as number) < 1 || (rows as number) > 500) {
    throw invalidParams('rows must be an integer from 1 to 500', { field: 'rows', expected: '1..500' });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`${field} must be a non-empty string`, { field });
  }
  return value;
}

export function registerTerminalMethods(core: Core): void {
  const router: Router = core.router;
  router.register('terminals.open', (params, ctx) => {
    const state = core.terminals.openThread(requireString(params.threadId, 'threadId') as ThreadId, params.cols, params.rows, params.terminalId);
    core.terminals.watch(state.id, ctx.connection.id);
    return state;
  });
  router.register('terminals.list', (params) => {
    const threadId = requireString(params.threadId, 'threadId') as ThreadId;
    core.threads.require(threadId);
    return core.terminals.listThread(threadId);
  });
  router.register('terminals.write', (params) => {
    if (typeof params.data !== 'string') throw invalidParams('data must be a string', { field: 'data' });
    return core.terminals.write(requireString(params.id, 'id'), params.data);
  });
  router.register('terminals.resize', (params) =>
    core.terminals.resize(requireString(params.id, 'id'), params.cols, params.rows));
  router.register('terminals.close', (params, ctx) => {
    const id = requireString(params.id, 'id');
    // The closing window's pane goes now; the others keep the last lines until `terminal.exited`.
    core.terminals.unwatch(id, ctx.connection.id);
    return core.terminals.close(id);
  });
  router.register('terminals.history', (params) => core.terminals.history(requireString(params.id, 'id')));
}
