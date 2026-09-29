/*
 * Shells in a pseudo-terminal. A thread has one, opened under the chat with
 * Ctrl+J in the thread's working directory, and an account whose CLI signs in
 * through an interactive menu gets one with its login command typed in. Each
 * shell goes through `procs.spawnTerminal` under its own trace id, never the
 * thread's: stopping a turn must not take the user's shell with it.
 */

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import type { TerminalState, ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, notFound, refused } from './errors.ts';
import type { Router } from './router.ts';

/** What a late client is sent to redraw the screen. A full-screen app redraws itself anyway. */
export const HISTORY_CHARS = 256 * 1024;
/**
 * Output that follows other output within this window goes out as one event. The
 * first chunk after a quiet window goes at once, so a typed key echoes without delay.
 */
export const OUTPUT_WINDOW_MS = 16;
/** Chunks the history holds before it joins them into one string. */
const HISTORY_CHUNKS = 4096;
/** The shell prints its prompt, then goes quiet: that is when a typed command lands on it. */
const PROMPT_QUIET_MS = 250;
/** A shell that never goes quiet still gets the command. */
const PROMPT_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;

export function threadTerminalId(threadId: ThreadId): string {
  return `terminal:${threadId}`;
}

export interface Shell {
  exe: string;
  args: string[];
  kind: 'powershell' | 'cmd' | 'posix';
}

/**
 * `BOITE_TERMINAL_SHELL` when set, else PowerShell 7 when it is on the PATH,
 * the Windows PowerShell every Windows has, then cmd. `$SHELL` elsewhere, then
 * bash, then sh.
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
  const named = env['SHELL'];
  if (named !== undefined && named.length > 0 && exists(named)) return { exe: named, args: [], kind: 'posix' };
  return { exe: exists('/bin/bash') ? '/bin/bash' : '/bin/sh', args: [], kind: 'posix' };
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
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly max = HISTORY_CHARS) {}

  push(data: string): void {
    this.chunks.push(data);
    this.length += data.length;
    // Drop whole chunks while what is left still covers the window.
    while (this.chunks.length > 1 && this.length - this.chunks[0]!.length >= this.max) {
      this.length -= this.chunks.shift()!.length;
    }
    if (this.chunks.length > HISTORY_CHUNKS) {
      const joined = this.text();
      this.chunks = [joined];
      this.length = joined.length;
    }
  }

  text(): string {
    const all = this.chunks.join('');
    return all.length > this.max ? all.slice(-this.max) : all;
  }
}

interface Session {
  id: string;
  cwd: string;
  terminal: Bun.Terminal;
  /** Exactly what `terminal.output` events carried so far, so a snapshot and the events after it never overlap. */
  history: OutputHistory;
  exited: Promise<number | null>;
  /** Killed, not gone yet: it takes no keys, and its id is not free for a new shell. */
  closing: boolean;
}

export interface StartOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  /** A command typed into the shell once its prompt is up. */
  type?: string[];
  onExit?: () => void;
}

export class TerminalStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly core: Core) {}

  /** The thread's shell, started in its working directory the first time. */
  openThread(threadId: ThreadId, cols: number, rows: number): TerminalState {
    const thread = this.core.threads.require(threadId);
    if (thread.archived) throw refused(`the thread ${threadId} is archived`, { threadId, field: 'archived', expected: false });
    return this.open(threadTerminalId(threadId), { cwd: thread.cwd, env: { ...process.env }, cols, rows });
  }

  /** The running shell under this id, resized to the client that attaches, or a new one. */
  open(id: string, options: StartOptions): TerminalState {
    checkSize(options.cols, options.rows);
    const running = this.sessions.get(id);
    if (running !== undefined) {
      if (running.closing) throw refused(`the shell ${id} is still closing, open it again in a moment`, { id });
      running.terminal.resize(options.cols, options.rows);
      return { id, cwd: running.cwd, output: running.history.text() };
    }
    if (!existsSync(options.cwd)) {
      throw refused(`the working directory ${options.cwd} does not exist any more`, { id, cwd: options.cwd });
    }
    const shell = pickShell();
    const decoder = new TextDecoder();
    let session: Session | null = null;
    let typed = options.type === undefined;
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
      history.push(data);
      this.core.bus.emit('terminal.output', { id, data });
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
      spawned = this.core.procs.spawnTerminal(id, shell.exe, shell.args, {
        cwd: options.cwd,
        env,
        cols: options.cols,
        rows: options.rows,
        onData: (bytes) => {
          const data = decoder.decode(bytes, { stream: true });
          if (data.length === 0) return;
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
      throw refused(`the shell ${shell.exe} did not start: ${messageOf(error)}`, { id, shell: shell.exe });
    }
    const exited = spawned.exited.then(
      (code) => code,
      () => null,
    ).then((code) => {
      clearTimeout(fallback);
      if (quiet !== null) clearTimeout(quiet);
      if (gate !== null) clearTimeout(gate);
      gate = null;
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      if (!this.core.journal.isClosed()) {
        // The last lines a shell printed go out before its exit, never after.
        if (held.length > 0) emit(held);
        held = '';
        this.core.bus.emit('terminal.exited', { id, exitCode: code });
      }
      options.onExit?.();
      return code;
    });
    session = { id, cwd: options.cwd, terminal: spawned.terminal, history, exited, closing: false };
    this.sessions.set(id, session);
    return { id, cwd: options.cwd, output: '' };
  }

  has(id: string): boolean {
    return this.sessions.has(id);
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
    const session = this.sessions.get(id);
    if (session === undefined) return { ok: true };
    session.closing = true;
    this.core.procs.killTree(id);
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

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
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
  router.register('terminals.open', (params) =>
    core.terminals.openThread(requireString(params.threadId, 'threadId') as ThreadId, params.cols, params.rows));
  router.register('terminals.write', (params) => {
    if (typeof params.data !== 'string') throw invalidParams('data must be a string', { field: 'data' });
    return core.terminals.write(requireString(params.id, 'id'), params.data);
  });
  router.register('terminals.resize', (params) =>
    core.terminals.resize(requireString(params.id, 'id'), params.cols, params.rows));
  router.register('terminals.close', (params) => core.terminals.close(requireString(params.id, 'id')));
}
