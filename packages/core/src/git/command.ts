/*
 * How the core starts git. Two things differ on Windows only:
 *
 * - Git cannot create or delete a path over 260 characters there unless
 *   `core.longpaths` is set, and a worktree adds about 30 characters to every
 *   path of the repository. The OS-wide long path switch does not cover git.
 * - Git for Windows puts a launcher on PATH (`<Git>\cmd\git.exe`, or
 *   `<Git>\bin\git.exe` in the portable build) that starts the real binary
 *   under `<Git>\<build>\bin`: one process more for every git call.
 *
 * Every other platform gets git as PATH finds it, with nothing added.
 */

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

type Env = Record<string, string | undefined>;

/** Where a Git for Windows install keeps the real binary: x64 since 2.56, ARM64, x64 before 2.56, 32-bit. */
const GIT_FOR_WINDOWS_BUILDS = ['ucrt64', 'clangarm64', 'mingw64', 'mingw32'] as const;

/**
 * `core.longpaths=true` through `GIT_CONFIG_*`, so the arguments stay the same
 * on every platform and nothing is written to the user's git config. The entry
 * is appended after inherited ones, found without case since Windows reads
 * environment names that way. A count git itself would reject is left alone,
 * so git still reports it.
 */
export function longPathConfigEnv(platform: NodeJS.Platform, env: Env): Env {
  if (platform !== 'win32') return {};
  const countKey = Object.keys(env).find((key) => key.toUpperCase() === 'GIT_CONFIG_COUNT') ?? 'GIT_CONFIG_COUNT';
  const inherited = env[countKey];
  // Git reads the count with strtoul: leading blanks, an optional plus, digits and nothing after.
  if (inherited !== undefined && inherited !== '' && !/^[ \t\r\n\v\f]*\+?\d+$/.test(inherited)) return {};
  const count = inherited === undefined || inherited === '' ? 0 : Number.parseInt(inherited.trim(), 10);
  return {
    [countKey]: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.longpaths',
    [`GIT_CONFIG_VALUE_${count}`]: 'true',
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The real `git.exe` behind Git for Windows' launcher, or `executable` itself
 * when it is not that launcher or the layout is absent. The launcher stays when
 * MSYSTEM is set: the real binary adds its own folders to PATH (hooks, ssh,
 * credential helpers) only when MSYSTEM is unset, and inside an MSYS shell the
 * launcher is what sets them up.
 */
export function realGitForWindows(executable: string, env: Env, exists: (path: string) => boolean = isFile): string {
  if (env.MSYSTEM) return executable;
  if (win32.basename(executable).toLowerCase() !== 'git.exe') return executable;
  const launcherFolder = win32.dirname(executable);
  const folder = win32.basename(launcherFolder).toLowerCase();
  if (folder !== 'cmd' && folder !== 'bin') return executable;
  const root = win32.dirname(launcherFolder);
  // `<Git>\ucrt64\bin\git.exe` is already the real binary.
  if ((GIT_FOR_WINDOWS_BUILDS as readonly string[]).includes(win32.basename(root).toLowerCase())) return executable;
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = win32.join(root, build, 'bin', 'git.exe');
    if (exists(candidate)) return candidate;
  }
  return executable;
}

function pathOf(env: Env): string | undefined {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? undefined : env[key];
}

/** PATH lookups by PATH and MSYSTEM: one scan per distinct environment, not one per git call. */
const resolved = new Map<string, string>();

export interface GitLaunch {
  /** The executable to start: `git`, or the real Git for Windows binary. */
  command: string;
  /** Variables to add to the child's environment, empty off Windows. */
  env: Env;
}

/**
 * The command and extra environment for a git process given the environment
 * it will run with. `which` and `exists` are for tests; the defaults search
 * PATH with Bun and stat the candidate. A cached binary that disappeared, as
 * after a Git upgrade that moved it, is looked up again.
 */
export function gitLaunch(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  which: (command: string, path: string | undefined) => string | null = (command, path) => Bun.which(command, path === undefined ? {} : { PATH: path }),
  exists: (path: string) => boolean = isFile,
): GitLaunch {
  if (platform !== 'win32') return { command: 'git', env: {} };
  const path = pathOf(env);
  const key = `${path ?? ''}\0${env.MSYSTEM ? 'msystem' : ''}`;
  let command = resolved.get(key);
  if (command === undefined || (command !== 'git' && !exists(command))) {
    const found = which('git', path);
    // A `git.cmd` wrapper needs cmd.exe, which cuts a multi-line argument at its first newline: Bun's own lookup keeps it.
    command = found === null || !found.toLowerCase().endsWith('.exe') ? 'git' : realGitForWindows(found, env, exists);
    resolved.set(key, command);
  }
  return { command, env: longPathConfigEnv(platform, env) };
}

/**
 * The executable and environment a process starts with, for `procs.ts`. Only
 * git changes, and only on Windows; the trace still names the command asked
 * for. An absent environment stays absent for any other command (inherited).
 */
export function launchOf<E extends Env | undefined>(cmd: string, env: E): [string, E] {
  if (cmd !== 'git') return [cmd, env];
  const launch = gitLaunch(env ?? process.env);
  return [launch.command, (Object.keys(launch.env).length === 0 ? env : { ...(env ?? process.env), ...launch.env }) as E];
}

/** Tests start from an empty lookup cache. */
export function forgetGitLaunches(): void {
  resolved.clear();
}
