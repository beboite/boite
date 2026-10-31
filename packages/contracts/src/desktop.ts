/**
 * A conversation's private virtual desktop on a Linux machine: an X server in
 * memory with a window manager and the accessibility bus, where an agent runs
 * GUI apps and drives them through agent-desktop without touching the user's
 * screen (docs/desktop.md).
 */

/** Whether this machine can start one, and why not, phrased for the person who would install the tools. */
export interface VirtualDesktopSupport {
  available: boolean;
  reason?: string;
  /** The programs not found, by the name a package manager knows them. */
  missing?: string[];
}

/** A program started on the desktop with `desktop.run`. */
export interface VirtualDesktopApp {
  pid: number;
  /** The command as given, joined with spaces, at most 200 characters. */
  command: string;
  startedAt: number;
  /** Null while it runs. */
  exitCode: number | null;
  /** Its stdout and stderr, the first 1 MB of each run. */
  log: string;
}

export interface VirtualDesktopSession {
  /** The X display, `:3`. */
  display: string;
  width: number;
  height: number;
  startedAt: number;
  /**
   * What a program needs to reach the desktop: DISPLAY, XAUTHORITY, the D-Bus
   * session, the accessibility switches and agent-desktop's state folder.
   * Keys whose value is empty are to be removed from the environment.
   */
  env: Record<string, string>;
  apps: VirtualDesktopApp[];
}

export const VIRTUAL_DESKTOP_SIZE = { min: 320, max: 3840, defaultWidth: 1280, defaultHeight: 800 } as const;
/** `desktop.run` limits: words of one command and characters of one word. */
export const VIRTUAL_DESKTOP_COMMAND = { words: 256, chars: 32_768 } as const;
/** Apps a desktop remembers; the oldest that exited goes first. */
export const VIRTUAL_DESKTOP_APPS_MAX = 32;

export interface DesktopRpcMethods {
  /** What this conversation's desktop runs, or null, and whether the machine can start one. */
  'desktop.status': { params: { threadId: string }; result: { support: VirtualDesktopSupport; session: VirtualDesktopSession | null } };
  /** Starts the conversation's desktop, or returns the one it has. */
  'desktop.start': { params: { threadId: string; width?: number; height?: number }; result: { session: VirtualDesktopSession } };
  /**
   * Starts `command` on the desktop, starting the desktop first if needed, in
   * `cwd` (absolute). It outlives the turn and stops with the desktop.
   */
  'desktop.run': { params: { threadId: string; command: string[]; cwd: string }; result: { app: VirtualDesktopApp; session: VirtualDesktopSession } };
  /** Stops the desktop and everything started on it. */
  'desktop.stop': { params: { threadId: string }; result: { stopped: boolean } };
}

/** The one problem with a desktop size, or null. */
export function virtualDesktopSizeError(width: unknown, height: unknown): string | null {
  const ok = (value: unknown) => value === undefined || (Number.isInteger(value) && (value as number) >= VIRTUAL_DESKTOP_SIZE.min && (value as number) <= VIRTUAL_DESKTOP_SIZE.max);
  return ok(width) && ok(height) ? null : `width and height must be whole pixels from ${VIRTUAL_DESKTOP_SIZE.min} to ${VIRTUAL_DESKTOP_SIZE.max}`;
}

/** The one problem with a command to run, or null. */
export function virtualDesktopCommandError(command: unknown): string | null {
  if (!Array.isArray(command) || command.length === 0 || command.length > VIRTUAL_DESKTOP_COMMAND.words) return `command must be 1 to ${VIRTUAL_DESKTOP_COMMAND.words} words`;
  if (!command.every(word => typeof word === 'string' && word.length <= VIRTUAL_DESKTOP_COMMAND.chars && !word.includes('\0'))) return `each word of command must be text of at most ${VIRTUAL_DESKTOP_COMMAND.chars} characters with no NUL`;
  return (command[0] as string).length > 0 ? null : 'command must start with a program';
}
