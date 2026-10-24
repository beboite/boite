/**
 * The git remote an agent works on, read from the repository's config file
 * rather than by running git: an ask must not start a process. Only the host
 * and path leave this machine, never credentials a URL may carry.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { invalidParams } from '../errors.ts';

/** How far up a checkout's `.git` is looked for. */
const MAX_DEPTH = 64;

/** The repository directory holding `config`, worktrees and submodules followed to their common directory. */
export function gitCommonDirOf(start: string): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const candidate = join(dir, '.git');
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(candidate, 'utf8'))?.[1];
        if (!pointer) return null;
        const gitDir = resolve(dir, pointer);
        const common = join(gitDir, 'commondir');
        return existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir;
      }
    } catch { /* No `.git` here: look one level up. */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** `origin`'s URL, else the first remote's, from a git config file's text. */
export function remoteFromConfig(config: string): string | null {
  const remotes: { name: string; url: string }[] = [];
  let section: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line);
    if (header) { section = header[1]!; continue; }
    if (line.startsWith('[')) { section = null; continue; }
    const entry = /^url\s*=\s*(.+)$/i.exec(line);
    if (section !== null && entry && !remotes.some(remote => remote.name === section)) remotes.push({ name: section, url: entry[1]!.replace(/^"|"$/g, '').trim() });
  }
  return (remotes.find(remote => remote.name === 'origin') ?? remotes[0])?.url ?? null;
}

/**
 * `host/owner/repo`, lowercase, without scheme, user, port of a scp-like URL
 * or `.git`: two clones of one repository read the same, whichever protocol
 * each uses. Null for a local path or anything without a host.
 */
export function normalizeRemote(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value || value.length > 2048) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol === 'file:' || !url.hostname) return null;
    host = url.hostname;
    path = url.pathname;
  } else if (scp) {
    // A Windows drive (`C:\repo`) is a path, not a host.
    if (/^[a-z]$/i.test(scp[1]!)) return null;
    host = scp[1]!;
    path = scp[2]!;
  } else return null;
  value = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!value || !/^[a-z0-9.-]+$/i.test(host)) return null;
  return `${host}/${value}`.toLowerCase();
}

/** A remote as a contact's core sends it, already normalized: `host/path`, or refused naming the field. */
export function checkNormalizedRemote(value: unknown, field: string): string {
  const remote = typeof value === 'string' && value.length <= 2048 ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*(\/[a-z0-9._~%+@-]+)+$/.test(remote) || remote.split('/').some(part => part === '.' || part === '..')) {
    throw invalidParams(`${field}: expected a normalized git remote, host/path such as github.com/owner/repo`, { field });
  }
  return remote;
}

/** The normalized remote of the checkout `cwd` is in, or null. */
export function gitRemoteOf(cwd: string): string | null {
  try {
    const gitDir = gitCommonDirOf(cwd);
    if (gitDir === null) return null;
    const config = join(gitDir, 'config');
    if (!existsSync(config) || statSync(config).size > 1_048_576) return null;
    return normalizeRemote(remoteFromConfig(readFileSync(config, 'utf8')));
  } catch { return null; }
}
