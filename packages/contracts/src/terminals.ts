import type { ThreadId } from './ids';

/** The most shells one thread runs at once. */
export const MAX_THREAD_TERMINALS = 16;
/**
 * What a client names a thread's further shells by: `term-2` to `term-16`, as
 * T3 Code numbers them. With the first, that is `MAX_THREAD_TERMINALS` at most.
 */
export const THREAD_TERMINAL_KEY = /^term-([2-9]|1[0-6])$/;

/**
 * The id of a thread's shell: `terminal:<threadId>` for its first, the one a
 * thread had before it could have several, `terminal:<threadId>:<terminalId>`
 * for the others.
 */
export function threadTerminalId(threadId: ThreadId, terminalId?: string): string {
  return terminalId === undefined ? `terminal:${threadId}` : `terminal:${threadId}:${terminalId}`;
}

/** Whether this shell id is one of the thread's: its first, or one named after it. */
export function isThreadTerminal(threadId: ThreadId, id: string): boolean {
  const first = threadTerminalId(threadId);
  return id === first || (id.startsWith(`${first}:`) && THREAD_TERMINAL_KEY.test(id.slice(first.length + 1)));
}

/** One of a thread's running shells, as `terminals.list` reports them. */
export interface ThreadTerminal {
  id: string;
  /** Absent for the thread's first shell. */
  terminalId?: string;
  cwd: string;
}

/**
 * A shell the core runs in a pseudo-terminal. Its id names what it belongs to:
 * `threadTerminalId` for a thread's, `login:<accountId>` for a sign-in.
 */
export interface TerminalState {
  id: string;
  /** Where the shell started. */
  cwd: string;
  /** What it printed lately, so a client that attaches late draws the same screen. */
  output: string;
  /** Last output event included in this snapshot; absent on older cores. */
  sequence?: number;
  /**
   * Set when the shell runs under ConPTY, with the Windows build number: ConPTY
   * rewraps lines itself, and the emulator must know which builds do, or a
   * resize draws lines twice. Absent on Linux, macOS and older cores.
   */
  windowsPty?: { buildNumber: number };
  /** The shell that runs, and whether it marks its prompts and commands (OSC 133). Absent on older cores. */
  shell?: TerminalShell;
}

/**
 * A terminal's shell. `integrated` is true when the core started it with its
 * shell integration: each prompt and command is marked with OSC 133, and the
 * working directory follows with OSC 633 P Cwd.
 */
export interface TerminalShell {
  /** The executable's name without `.exe`: `pwsh`, `powershell`, `bash`, `cmd`, `zsh`. */
  name: string;
  kind: 'powershell' | 'cmd' | 'posix';
  integrated: boolean;
}

export interface TerminalsRpcMethods {

  /**
   * Attach to one of the thread's shells, starting it in the thread's working
   * directory when it does not run. Without `terminalId`, the thread's first
   * shell; with one (`THREAD_TERMINAL_KEY`, `term-2` to `term-16`), another.
   */
  'terminals.open': { params: { threadId: ThreadId; cols: number; rows: number; terminalId?: string }; result: TerminalState };
  /** The thread's running shells, in the order they started. */
  'terminals.list': { params: { threadId: ThreadId }; result: ThreadTerminal[] };
  /** Keystrokes, as the terminal emulator encodes them. */
  'terminals.write': { params: { id: string; data: string }; result: { ok: true } };
  'terminals.resize': { params: { id: string; cols: number; rows: number }; result: { ok: true } };
  /** Kill the shell and its tree. `terminal.exited` follows. */
  'terminals.close': { params: { id: string }; result: { ok: true } };
  /**
   * The shell's recent commands from its own history file, newest first and
   * each once: what the up arrow walks through, across past sessions too.
   * Empty for a shell that keeps none (cmd, sh).
   */
  'terminals.history': { params: { id: string }; result: { commands: string[] } };
}

export interface TerminalsRpcEvents {
  /** What a shell printed, as it printed it. */
  'terminal.output': { id: string; data: string; sequence?: number };
  /** The shell ended: typed `exit`, closed, or killed with its thread. */
  'terminal.exited': { id: string; exitCode: number | null };
}
