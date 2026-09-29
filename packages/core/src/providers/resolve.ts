import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, normalize } from 'node:path';
import type { ExecutableCandidate, Os, OsProfile, ProviderDescriptor } from '@boite/contracts';
import { currentOs } from '../paths.ts';
import { substituteHome } from './expand.ts';
import { globalRoots, resolveNpm } from './npm.ts';
import { which } from './which.ts';

/**
 * `BOITE_HOST_AGENTS=0` keeps a core away from the agents installed on the
 * machine it runs on: the shipped descriptors still load, but none of them
 * resolves a program, so no version check, quota read or model probe starts
 * one. The e2e suite sets it, because a core it drives must never run the
 * developer's own CLIs.
 */
export function hostAgentsEnabled(): boolean {
  return process.env['BOITE_HOST_AGENTS'] !== '0';
}

/**
 * The shipped candidate lists `BOITE_HOST_AGENTS=0` resolves to nothing. A test
 * that swaps a profile's list for its own fixture program gets that program.
 */
export const HOST_CANDIDATES = new WeakSet<ExecutableCandidate[]>();

/**
 * A global npm `node_modules` directory, expanded when a file candidate is
 * resolved rather than when the descriptor loads: which prefix holds the
 * package (default npm, nvm-windows, fnm, scoop, a custom prefix) is only known
 * from the environment and PATH of the moment.
 */
export const NPM_ROOT = '{npmRoot}';

/**
 * The environment a process of this provider runs under: what it inherited,
 * minus the names the profile unsets, plus the account's own. `unsetEnv` is
 * matched without case, because Windows treats a variable name that way and an
 * alias would otherwise slip through.
 */
export function agentEnv(
  descriptor: ProviderDescriptor,
  accountEnv: Record<string, string>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const unset = new Set((profileFor(descriptor)?.unsetEnv ?? []).map((name) => name.toUpperCase()));
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (unset.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return { ...env, ...accountEnv };
}

/**
 * What a profile launches: the program, the arguments that belong to it before
 * the descriptor's own (the bin script, for an `npm` candidate), and the path a
 * person recognises as the agent, which for a script is the script, not Node.
 */
export interface ResolvedCommand {
  executable: string;
  prefix: string[];
  shown: string;
  /** The candidate's `updateEnv`, empty when it names none. */
  updateEnv: Record<string, string>;
}

/**
 * A Windows launcher script (an npm `.cmd` or `.ps1` shim, a `.bat`). The
 * drivers spawn through node's `child_process.spawn`, which refuses one with
 * EINVAL, so a PATH hit on one is not a way to start the agent.
 */
export function isLauncherScript(path: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(path);
}

/**
 * `which`, passing over launcher scripts on Windows to the next PATH
 * directory that holds a real program of that name. `scripts` keeps them, for a
 * profile that names a launcher script itself and maps it to its program.
 */
export function whichProgram(name: string, scripts = false): string | null {
  // Named outright: Bun.which alone would keep the PATH the process started with.
  const PATH = process.env['PATH'] ?? '';
  const found = which(name, PATH);
  if (found === null || scripts || !isLauncherScript(found)) return found;
  for (const dir of PATH.split(delimiter)) {
    if (dir.length === 0) continue;
    const hit = which(name, dir);
    if (hit !== null && !isLauncherScript(hit)) return hit;
  }
  return null;
}

/** True when the profile names a launcher script as a file, so its driver knows what to make of one. */
function takesScripts(profile: OsProfile): boolean {
  return profile.executable.some((candidate) => candidate.kind === 'file' && isLauncherScript(candidate.value));
}

export function resolveCommand(profile: OsProfile): ResolvedCommand | null {
  if (HOST_CANDIDATES.has(profile.executable)) return null;
  const scripts = takesScripts(profile);
  for (const candidate of profile.executable) {
    const updateEnv = candidate.updateEnv ?? {};
    if (candidate.kind === 'path') {
      const found = whichProgram(candidate.value, scripts);
      if (found !== null) return { executable: found, prefix: [], shown: found, updateEnv };
    } else if (candidate.kind === 'file') {
      for (const path of filePaths(candidate.value, profile)) {
        if (runnableFile(path)) return { executable: path, prefix: [], shown: path, updateEnv };
      }
    } else if (candidate.kind === 'npm') {
      const found = resolveNpm(candidate.value);
      if (found !== null) return { executable: found.executable, prefix: [found.script], shown: found.script, updateEnv };
    }
  }
  return null;
}

function runnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Missing or non-executable candidates leave the next one available.
    return false;
  }
}

/**
 * The paths a file candidate stands for: itself, or with `{npmRoot}` one per
 * global npm root. The profile's PATH names are the hints, so the prefix whose
 * shim is on PATH is looked in, whatever Node manager put it there.
 */
function filePaths(value: string, profile: OsProfile): string[] {
  if (!value.startsWith(NPM_ROOT)) return [value];
  const rest = value.slice(NPM_ROOT.length);
  const hints = profile.executable.filter((candidate) => candidate.kind === 'path').map((candidate) => candidate.value);
  const roots: string[] = [];
  for (const hint of hints.length === 0 ? [null] : hints) {
    for (const root of globalRoots(hint)) if (!roots.includes(root)) roots.push(root);
  }
  return roots.map((root) => normalize(root + rest));
}

/**
 * The launcher script PATH holds for this profile when nothing it names is a
 * program Boite can start: what the person installed, and the reason the agent
 * still reads as missing. Null off Windows, when a candidate resolves, or when
 * the profile takes launcher scripts itself.
 */
export function launcherScriptOnly(profile: OsProfile): string | null {
  if (process.platform !== 'win32' || HOST_CANDIDATES.has(profile.executable) || takesScripts(profile)) return null;
  if (resolveCommand(profile) !== null) return null;
  for (const candidate of profile.executable) {
    if (candidate.kind !== 'path') continue;
    const found = which(candidate.value);
    if (found !== null && isLauncherScript(found)) return found;
  }
  return null;
}

/** The program to spawn, for a driver that needs the path. Its arguments start with `launchPrefix`. */
export function resolveExecutable(profile: OsProfile): string | null {
  return resolveCommand(profile)?.executable ?? null;
}

/** The descriptor's launch arguments behind whatever the resolved program needs first. */
export function launchPrefix(profile: OsProfile | undefined): string[] {
  return profile === undefined ? [] : (resolveCommand(profile)?.prefix ?? []);
}

export function detectResolves(profile: OsProfile, agentsDir: string, dataDir: string): boolean {
  if (profile.detect.file !== undefined && !existsSync(substituteHome(profile.detect.file, agentsDir, dataDir))) {
    return false;
  }
  if (profile.detect.command !== undefined && whichProgram(profile.detect.command, takesScripts(profile)) === null) return false;
  return true;
}

export function profileFor(descriptor: ProviderDescriptor, os: Os = currentOs()): OsProfile | undefined {
  return descriptor.profiles[os];
}
