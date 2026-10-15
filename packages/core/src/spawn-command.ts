import { statSync } from 'node:fs';
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
  isFile(path: string): boolean;
}

/** How long a launcher swap is trusted, as long as the PATH lookup behind it. */
const SWAP_TTL_MS = 30_000;
/**
 * Git for Windows 2.56 moved x64 builds from mingw64 to ucrt64; ARM64 builds
 * live in clangarm64 and 32-bit ones in mingw32.
 */
const GIT_FOR_WINDOWS_BUILDS = ['ucrt64', 'clangarm64', 'mingw64', 'mingw32'] as const;

let swaps = new Map<string, { at: number; real: string }>();

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const hostLookup: SpawnLookup = { windows: process.platform === 'win32', which, isFile };

/** An environment variable, by any case on Windows, where `Path` is the usual spelling. */
function envValue(env: Record<string, string | undefined>, name: string, windows: boolean): string | undefined {
  if (!windows || env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) return env[key];
  return undefined;
}

/**
 * Git for Windows' launcher (`<Git>\cmd\git.exe`, the only git its installer
 * puts on PATH, or the portable build's `<Git>\bin\git.exe`) swapped for the
 * git.exe it starts. The launcher costs a second process on every git command
 * and leaks a kernel token reference per run. The real binary sets HOME and,
 * when MSYSTEM is unset, puts its own folders on PATH for hooks, ssh and
 * credential helpers, so the launcher stays when MSYSTEM is set. Any other path
 * comes back as is.
 */
export function preferGitForWindowsBinary(
  executable: string,
  env: Record<string, string | undefined>,
  fileExists: (path: string) => boolean = isFile,
): string {
  if (envValue(env, 'MSYSTEM', true)) return executable;
  if (win32.basename(executable).toLowerCase() !== 'git.exe') return executable;
  const launcherDir = win32.dirname(executable);
  const folder = win32.basename(launcherDir).toLowerCase();
  if (folder !== 'cmd' && folder !== 'bin') return executable;
  const root = win32.dirname(launcherDir);
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = win32.join(root, build, 'bin', 'git.exe');
    if (fileExists(candidate)) return candidate;
  }
  return executable;
}

/** The launcher swap, remembered: its file checks would otherwise run before every git spawn. */
function swapLauncher(found: string, env: Record<string, string | undefined>, lookup: SpawnLookup): string {
  if (envValue(env, 'MSYSTEM', true)) return found;
  const now = Date.now();
  const kept = swaps.get(found);
  if (kept !== undefined && now - kept.at < SWAP_TTL_MS) return kept.real;
  const real = preferGitForWindowsBinary(found, env, lookup.isFile);
  if (swaps.size >= 64) swaps = new Map();
  swaps.set(found, { at: now, real });
  return real;
}

/**
 * The absolute path to spawn for `cmd`, or `cmd` itself when it already names
 * a path, is not on the child's PATH, or resolves to something only a shell
 * can start (a `.cmd`, `.bat` or `.ps1` shim on Windows): Bun and node keep
 * their own handling of those.
 */
export function resolveSpawnCommand(cmd: string, env: Record<string, string | undefined>, lookup: SpawnLookup = hostLookup): string {
  const { windows } = lookup;
  if (cmd.length === 0 || cmd.includes('/') || (windows && (cmd.includes('\\') || cmd.includes(':')))) return cmd;
  const found = lookup.which(cmd, envValue(env, 'PATH', windows) ?? '');
  if (found === null || !(windows ? win32 : posix).isAbsolute(found)) return cmd;
  if (!windows) return found;
  const extension = win32.extname(found).toLowerCase();
  if (extension !== '.exe' && extension !== '.com') return cmd;
  return win32.basename(found).toLowerCase() === 'git.exe' ? swapLauncher(found, env, lookup) : found;
}

/** Forgets every lookup and swap: a spawn of a resolved path found nothing there. */
export function forgetSpawnCommands(): void {
  swaps = new Map();
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
