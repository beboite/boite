import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { currentOs, homePath } from '../paths.ts';
import { Remembered, which } from './which.ts';

/**
 * A CLI published on npm, found where a global install really put it. npm
 * writes a `.cmd` and a `.ps1` shim on Windows that Bun cannot spawn, and the
 * directory it installs into depends on the prefix, the Node manager and the
 * package manager, so a descriptor naming `{appdata}/npm/node_modules/...`
 * only finds the default npm on Windows. An `npm` candidate names the package
 * instead; this finds it, reads its `bin` from its own `package.json` and runs
 * that script with Node, or Bun when Node is not there.
 */
export interface NpmCommand {
  /** The runtime to spawn: node, else bun. */
  executable: string;
  /** The package's bin script, the first argument. */
  script: string;
}

/** `@scope/name`, optionally `#bin` when the package ships more than one command. */
const SPEC = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(#[a-zA-Z0-9._-]+)?$/;

export function isNpmSpec(value: string): boolean {
  return SPEC.test(value);
}

function splitSpec(value: string): { name: string; bin: string | null } {
  const hash = value.indexOf('#');
  return hash < 0 ? { name: value, bin: null } : { name: value.slice(0, hash), bin: value.slice(hash + 1) };
}

/** The directories a global install lands in, most specific first, without duplicates. */
export function globalRoots(binHint: string | null): string[] {
  const windows = currentOs() === 'windows';
  const home = homePath();
  const env = process.env;
  const roots: string[] = [];
  const add = (dir: string | undefined | null): void => {
    if (dir === undefined || dir === null || dir.length === 0) return;
    const full = resolve(dir);
    if (!roots.includes(full)) roots.push(full);
  };
  const prefixRoot = (prefix: string): string => (windows ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules'));

  const prefix = env['npm_config_prefix'] ?? env['NPM_CONFIG_PREFIX'];
  if (prefix) add(prefixRoot(prefix));
  if (windows) add(join(env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'));
  // The shims sit in the prefix itself on Windows and in `<prefix>/bin` elsewhere.
  for (const name of [binHint, 'npm', 'node']) {
    if (name === null) continue;
    const found = which(name);
    if (found === null) continue;
    const dir = dirname(windows ? found : realpathOr(found));
    add(windows ? join(dir, 'node_modules') : join(dir, '..', 'lib', 'node_modules'));
  }
  const pnpm = env['PNPM_HOME'] || (windows ? join(env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'pnpm') : currentOs() === 'macos' ? join(home, 'Library', 'pnpm') : join(home, '.local', 'share', 'pnpm'));
  add(join(pnpm, 'global', '5', 'node_modules'));
  add(join(env['BUN_INSTALL'] || join(home, '.bun'), 'install', 'global', 'node_modules'));
  if (!windows) {
    add(join(home, '.npm-global', 'lib', 'node_modules'));
    add('/usr/local/lib/node_modules');
    add('/opt/homebrew/lib/node_modules');
    add('/usr/lib/node_modules');
  }
  return roots;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The bin script of `name` under one root, or null when it is not there or names another package. */
function scriptIn(root: string, name: string, bin: string | null): string | null {
  const dir = join(root, ...name.split('/'));
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const pkg = parsed as { name?: unknown; bin?: unknown };
  if (pkg.name !== name) return null;
  let relativeScript: string | null = null;
  if (typeof pkg.bin === 'string') relativeScript = pkg.bin;
  else if (typeof pkg.bin === 'object' && pkg.bin !== null) {
    const entries = Object.entries(pkg.bin as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    const chosen = bin === null ? entries[0] : entries.find(([key]) => key === bin);
    relativeScript = chosen?.[1] ?? null;
  }
  if (relativeScript === null) return null;
  const script = resolve(dir, relativeScript);
  // A bin pointing outside its own package is not one Boite runs.
  const inside = relative(dir, script);
  if (inside.startsWith('..') || isAbsolute(inside) || !existsSync(script)) return null;
  return script;
}

/** Node beside the install first, since that is the one its shims would run, then PATH, then Bun. */
export function scriptRuntime(root: string): string | null {
  const windows = currentOs() === 'windows';
  const exe = windows ? 'node.exe' : 'node';
  const beside = windows ? join(root, '..', exe) : join(root, '..', '..', 'bin', exe);
  if (existsSync(beside)) return resolve(beside);
  const onPath = which('node');
  if (onPath !== null) return onPath;
  if (windows) {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const installed = join(programFiles, 'nodejs', exe);
    if (existsSync(installed)) return installed;
  } else {
    for (const path of ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']) if (existsSync(path)) return path;
  }
  return which('bun');
}

const resolved = new Remembered<NpmCommand | null>();

/**
 * The command an `npm` candidate resolves to, or null when the package or a
 * runtime for it is missing. Every provider list resolves the same specs, and
 * each walk stats about ten roots, so an answer is kept as long as a PATH
 * lookup and dropped with them by `forgetWhich` (a reload, an install, an
 * update). A kept answer whose script or runtime is gone is resolved again.
 */
export function resolveNpm(spec: string): NpmCommand | null {
  const env = process.env;
  const key = [spec, env['PATH'], env['npm_config_prefix'], env['NPM_CONFIG_PREFIX'], env['APPDATA'], env['LOCALAPPDATA'], env['PNPM_HOME'], env['BUN_INSTALL'], homePath()].join('\0');
  return resolved.get(key, () => walkRoots(spec), (found) => found === null || (existsSync(found.script) && existsSync(found.executable)));
}

function walkRoots(spec: string): NpmCommand | null {
  const { name, bin } = splitSpec(spec);
  for (const root of globalRoots(bin)) {
    const script = scriptIn(root, name, bin);
    if (script === null) continue;
    const executable = scriptRuntime(root);
    if (executable === null) return null;
    return { executable, script };
  }
  return null;
}

/** Where a global npm install put a program: the prefix its updater must install into, and what it replaces. */
export interface NpmInstall {
  /** The `--prefix` npm used: `/usr` for `/usr/lib/node_modules`, `%APPDATA%\npm` on Windows. */
  prefix: string;
  /** The package's own directory under `<prefix>/lib/node_modules`, or `<prefix>\node_modules` on Windows. */
  packageDir: string;
  /** The package as npm names it, `@anthropic-ai/claude-code`. */
  name: string;
}

/** The command names a package's `bin` declares, read from its own `package.json`. */
function binNames(packageDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { name?: unknown; bin?: unknown };
    if (typeof parsed.bin === 'string' && typeof parsed.name === 'string') return [parsed.name.split('/').at(-1)!];
    if (typeof parsed.bin === 'object' && parsed.bin !== null) return Object.keys(parsed.bin);
  } catch { /* No readable manifest: not a package npm installed. */ }
  return [];
}

/**
 * The global npm install a program belongs to, read from where its links lead.
 * An agent's updater runs `npm install -g`, which writes under npm's configured
 * prefix, not necessarily where the running copy lives: a copy under
 * `/opt/agents` updated with npm's `/usr` prefix lands beside it and PATH keeps
 * the old one. Two layouts are recognised: `<prefix>/lib/node_modules` on Unix,
 * and on Windows `<prefix>\node_modules` with npm's `.cmd` shim for one of the
 * package's commands in the prefix itself. pnpm and Bun put their packages
 * elsewhere, or their shims elsewhere, and are left to their own configuration.
 */
export function npmInstallOf(program: string): NpmInstall | null {
  const windows = currentOs() === 'windows';
  const real = realpathOr(program);
  const marker = windows ? `${sep}node_modules${sep}` : `${sep}lib${sep}node_modules${sep}`;
  // Windows paths compare without case: `Node_Modules` is the same folder.
  const at = (windows ? real.toLowerCase() : real).indexOf(marker);
  if (at < 0) return null;
  const prefix = at === 0 ? sep : real.slice(0, at);
  const [first = '', second = ''] = real.slice(at + marker.length).split(sep);
  if (first === '' || (first.startsWith('@') && second === '')) return null;
  const name = first.startsWith('@') ? `${first}/${second}` : first;
  const packageDir = join(prefix, ...(windows ? ['node_modules'] : ['lib', 'node_modules']), first, ...(first.startsWith('@') ? [second] : []));
  // A `node_modules` alone proves nothing on Windows: npm's own shim beside it does.
  if (windows && !binNames(packageDir).some((bin) => existsSync(join(prefix, `${bin}.cmd`)))) return null;
  return { prefix, packageDir, name };
}

/**
 * npm's own CLI, run by Node: the `npm` on PATH is a `.cmd` shim on Windows,
 * which Bun cannot spawn, and the script it starts is the same everywhere.
 */
export function npmCli(): NpmCommand | null {
  return resolveNpm('npm');
}

/**
 * The first directory `npm install -g` must write to replace this install and
 * that this user cannot write, or null. npm swaps the package inside its parent
 * directory and relinks it under `<prefix>/bin`, or the prefix on Windows.
 */
export function unwritableDir(install: NpmInstall): string | null {
  // npm's shims sit in the prefix itself on Windows.
  const bin = currentOs() === 'windows' ? install.prefix : join(install.prefix, 'bin');
  for (const dir of [dirname(install.packageDir), ...(existsSync(bin) ? [bin] : [])]) {
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      return dir;
    }
  }
  return null;
}
