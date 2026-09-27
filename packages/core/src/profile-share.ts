import { createHash } from 'node:crypto';
import {
  type Stats,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { OsProfile, ProviderShare } from '@boite/contracts';
import { messageOf } from './errors.ts';
import { currentOs, homePath } from './paths.ts';

/**
 * What an isolation variable means when it is not set, as segments under the
 * home directory. A descriptor that isolates an account through one of them
 * (OpenCode uses the XDG pair, Codex `CODEX_HOME`, pi `PI_CODING_AGENT_DIR`)
 * puts its session file under that same variable, so the provider's own location
 * is the variable's own default, never `~/.<id>`.
 */
export const ISOLATION_DEFAULTS: Record<string, string[]> = {
  XDG_DATA_HOME: ['.local', 'share'],
  XDG_CONFIG_HOME: ['.config'],
  XDG_STATE_HOME: ['.local', 'state'],
  XDG_CACHE_HOME: ['.cache'],
  CODEX_HOME: ['.codex'],
  CLAUDE_CONFIG_DIR: ['.claude'],
  GROK_HOME: ['.grok'],
  PI_CODING_AGENT_DIR: ['.pi', 'agent'],
};

/** The file at the root of an account's directory that says what Boite linked and copied there. */
export const SHARE_MARKER = '.boite-shared.json';

/** One shared path an account does not get, and why. */
export interface ShareProblem {
  path: string;
  message: string;
}

interface Marker {
  /** Links Boite made, relative to the account's directory, `/` separated. */
  links: string[];
  /** Copies Boite wrote, with the sha256 of what it wrote, so a later edit by anyone else is told apart. */
  files: Record<string, string>;
}

/** The provider's own directory behind an isolation variable: the environment's value, else its default. */
export function variableHome(variable: string): string | null {
  const value = process.env[variable];
  if (value !== undefined && value.length > 0) return value;
  const fallback = ISOLATION_DEFAULTS[variable];
  return fallback === undefined ? null : join(homePath(), ...fallback);
}

/**
 * Brings the provider's own profile into an account's directory: every
 * directory of `shares` is linked (a junction on Windows, which needs no
 * privilege), every file copied, again whenever the source changed. Whatever
 * already stood in the way and was never Boite's is set aside as
 * `<name>.own-<time>`, never deleted. A path the user removed from their own
 * profile goes from the account too, when what is there is still what Boite put.
 * Returns what could not be shared; the rest is done.
 */
export function shareProfile(isolationDir: string, profile: OsProfile, shares: readonly ProviderShare[]): ShareProblem[] {
  const problems: ShareProblem[] = [];
  const marker = readMarker(isolationDir);
  const before = JSON.stringify(marker);
  for (const share of shares) {
    const template = profile.isolation[share.variable];
    if (template === undefined) continue;
    const from = variableHome(share.variable);
    if (from === null) {
      for (const path of share.paths) {
        problems.push({ path, message: `Boite does not know where ${share.variable} points when it is not set` });
      }
      continue;
    }
    const to = template.split('{isolationDir}').join(isolationDir);
    if (samePath(from, to)) continue;
    for (const path of share.paths) {
      const target = join(to, path);
      const key = relative(isolationDir, target).split(sep).join('/');
      if (key.startsWith('..') || key.length === 0) {
        problems.push({ path, message: `${target} is outside the account directory` });
        continue;
      }
      const retarget = (share.retarget?.[path] ?? []).map((name): [string, string] => [join(from, name), join(to, name)]);
      try {
        const link = linkedParent(isolationDir, key);
        if (link !== null) {
          problems.push({ path, message: `${link} is a link, so ${target} would be written outside the account directory` });
          continue;
        }
        syncPath(join(from, path), target, key, retarget, marker);
      } catch (error) {
        problems.push({ path, message: messageOf(error) });
      }
    }
  }
  if (JSON.stringify(marker) !== before) writeFileSync(join(isolationDir, SHARE_MARKER), JSON.stringify(marker, null, 2), 'utf8');
  return problems;
}

/**
 * Removes the links `shareProfile` made, before the account's directory is
 * deleted. A recursive delete does not follow a junction or a symlink either;
 * this is so the order never depends on it.
 */
export function unshareProfile(isolationDir: string): void {
  for (const key of readMarker(isolationDir).links) {
    const target = join(isolationDir, key);
    if (linkedParent(isolationDir, key) !== null) continue;
    if (statEntry(target)?.isSymbolicLink() === true) unlinkSync(target);
  }
}

function syncPath(source: string, target: string, key: string, retarget: [string, string][], marker: Marker): void {
  const found = statEntry(source, true);
  const current = statEntry(target);
  if (found === undefined) {
    if (current?.isSymbolicLink() === true && marker.links.includes(key)) unlinkSync(target);
    else if (current?.isFile() === true && marker.files[key] === digest(readFileSync(target))) unlinkSync(target);
    forget(marker, key);
    return;
  }
  if (found.isDirectory()) {
    linkDirectory(source, target, key, current, marker);
    return;
  }
  copyFile(source, target, key, retarget, current, marker);
}

function linkDirectory(source: string, target: string, key: string, current: Stats | undefined, marker: Marker): void {
  if (current?.isSymbolicLink() === true) {
    if (samePath(readlinkSync(target), source)) {
      remember(marker, key, null);
      return;
    }
    // Boite's own link to where the variable pointed before: replaced. Anyone
    // else's is set aside like a directory would be.
    if (marker.links.includes(key)) unlinkSync(target);
    else renameSync(target, aside(target));
  } else if (current !== undefined) {
    renameSync(target, aside(target));
  }
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, 'junction');
  remember(marker, key, null);
}

function copyFile(
  source: string,
  target: string,
  key: string,
  retarget: [string, string][],
  current: Stats | undefined,
  marker: Marker,
): void {
  let content = readFileSync(source);
  if (retarget.length > 0) content = Buffer.from(retargeted(content.toString('utf8'), retarget), 'utf8');
  const wanted = digest(content);
  if (current?.isSymbolicLink() === true) {
    // Never written through: the copy may differ from the file a link reaches.
    // Boite's own link, from when the source was a directory, is replaced;
    // anyone else's is set aside like a file would be.
    if (marker.links.includes(key)) unlinkSync(target);
    else renameSync(target, aside(target));
  } else if (current?.isDirectory() === true) {
    renameSync(target, aside(target));
  } else if (current !== undefined) {
    const has = digest(readFileSync(target));
    if (has === wanted) {
      remember(marker, key, wanted);
      return;
    }
    // A file Boite never wrote is the account's own: kept aside once. Boite's
    // copy is replaced whoever edited it since, as the source is where the
    // user edits it; otherwise an agent that rewrites its settings on every
    // run would leave a new copy aside at every spawn.
    if (marker.files[key] === undefined) renameSync(target, aside(target));
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.boite-${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, target);
  remember(marker, key, wanted);
}

/**
 * Each absolute path in its raw form, with its separators doubled the way a
 * JSON or TOML basic string escapes them, and with forward slashes.
 */
function retargeted(text: string, pairs: [string, string][]): string {
  let out = text;
  for (const [from, to] of pairs) {
    for (const [a, b] of [
      [from.split('\\').join('\\\\'), to.split('\\').join('\\\\')],
      [from, to],
      [from.split('\\').join('/'), to.split('\\').join('/')],
    ] as const) {
      if (a.length > 0) out = out.split(a).join(b);
    }
  }
  return out;
}

function remember(marker: Marker, key: string, hash: string | null): void {
  if (hash === null) {
    if (!marker.links.includes(key)) marker.links.push(key);
    delete marker.files[key];
    return;
  }
  marker.files[key] = hash;
  marker.links = marker.links.filter((link) => link !== key);
}

function forget(marker: Marker, key: string): void {
  delete marker.files[key];
  marker.links = marker.links.filter((link) => link !== key);
}

function readMarker(isolationDir: string): Marker {
  try {
    const raw = JSON.parse(readFileSync(join(isolationDir, SHARE_MARKER), 'utf8')) as Partial<Marker>;
    const links = Array.isArray(raw.links) ? raw.links.filter((link): link is string => typeof link === 'string') : [];
    const files: Record<string, string> = {};
    if (typeof raw.files === 'object' && raw.files !== null) {
      for (const [key, hash] of Object.entries(raw.files)) if (typeof hash === 'string') files[key] = hash;
    }
    return { links, files };
  } catch {
    return { links: [], files: {} };
  }
}

/**
 * The first directory between the account's directory and a shared path that
 * is a link, or null. Whatever went through it would land outside the account,
 * and a later cleanup could delete a file there: the account's own link, or
 * Boite's for a directory another share path sits in.
 */
function linkedParent(isolationDir: string, key: string): string | null {
  let at = isolationDir;
  for (const segment of key.split('/').slice(0, -1)) {
    at = join(at, segment);
    const found = statEntry(at);
    if (found === undefined) return null;
    if (found.isSymbolicLink()) return at;
  }
  return null;
}

/**
 * What is at a path, or nothing. A path under a file is nothing too: Windows
 * says ENOENT there, Linux and macOS ENOTDIR, which `throwIfNoEntry` lets through.
 */
export function statEntry(path: string, follow = false): Stats | undefined {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function aside(target: string): string {
  return `${target}.own-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return currentOs() === 'windows' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
