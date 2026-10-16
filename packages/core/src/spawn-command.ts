import { posix, win32 } from 'node:path';
import { forgetWhich, which } from './providers/which.ts';

/**
 * What a bare command name a spawn names (`git`, `gh`) resolves to, looked up
 * once through the remembered `which` with the child's own PATH. Bun and node
 * otherwise walk PATH on every spawn, times every PATHEXT extension on Windows.
 * A changed PATH is another key, so it misses.
 */
export interface SpawnLookup {
  windows: boolean;
  which(name: string, PATH: string): string | null;
}

const hostLookup: SpawnLookup = { windows: process.platform === 'win32', which };

/** An environment variable, by any case on Windows, where `Path` is the usual spelling. */
function envValue(env: Record<string, string | undefined>, name: string, windows: boolean): string | undefined {
  if (!windows || env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) return env[key];
  return undefined;
}

/**
 * A PATH entry the spawn resolves from the child's own directory: a relative
 * one, or on POSIX an empty one, which names the current directory. A lookup
 * from the core's directory could find another program there.
 */
function hasRelativeEntry(PATH: string, windows: boolean): boolean {
  const path = windows ? win32 : posix;
  return PATH.split(path.delimiter).some((entry) => (windows ? entry !== '' && !path.isAbsolute(entry) : !path.isAbsolute(entry)));
}

/**
 * The absolute path to spawn for `cmd`, or `cmd` itself when it already names
 * a path, is not on the child's PATH, the PATH has a relative entry, or it
 * resolves to something only a shell can start (a `.cmd`, `.bat` or `.ps1`
 * shim on Windows): Bun and node keep their own handling of those.
 */
export function resolveSpawnCommand(cmd: string, env: Record<string, string | undefined>, lookup: SpawnLookup = hostLookup): string {
  const { windows } = lookup;
  if (cmd.length === 0 || cmd.includes('/') || (windows && (cmd.includes('\\') || cmd.includes(':')))) return cmd;
  const PATH = envValue(env, 'PATH', windows) ?? '';
  if (hasRelativeEntry(PATH, windows)) return cmd;
  const found = lookup.which(cmd, PATH);
  if (found === null || !(windows ? win32 : posix).isAbsolute(found)) return cmd;
  if (!windows) return found;
  const extension = win32.extname(found).toLowerCase();
  // Git for Windows' launcher was already swapped for its real binary (git/command.ts).
  return extension === '.exe' || extension === '.com' ? found : cmd;
}

/** Forgets every lookup: a spawn of a resolved path found nothing there. */
export function forgetSpawnCommands(): void {
  forgetWhich();
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Starts `cmd` through its resolved path. A resolved path that is gone (git
 * updated or moved under the remembered lookup) forgets the lookups and starts
 * the bare name once, as before.
 */
export function startResolved<T>(cmd: string, env: Record<string, string | undefined>, start: (executable: string) => T): T {
  const executable = resolveSpawnCommand(cmd, env);
  if (executable === cmd) return start(cmd);
  try {
    return start(executable);
  } catch (error) {
    if (!isMissing(error)) throw error;
    forgetSpawnCommands();
    return start(cmd);
  }
}

/** node reports a missing program as an async `error`: the next spawn looks again. */
export function forgetOnMissing(cmd: string, executable: string, error: unknown): void {
  if (executable !== cmd && isMissing(error)) forgetSpawnCommands();
}
