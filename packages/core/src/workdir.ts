/*
 * The thread's working directory, as a client may read it: one directory at a
 * time, one file, and the editor's save. Every path a caller names is resolved
 * inside that directory and refused outside it, real paths included, so a
 * symlink or a junction pointing out of the tree is not a way through.
 *
 * What is not text, or too big to be one, leaves through a ticket on the HTTP
 * server rather than a JSON frame: a video has to seek, and a picture carried
 * as base64 in a WebSocket message is paid for twice.
 */

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FILES_LIST_MAX, FILE_MAX_BYTES, FILE_ROUTE, FILE_TICKET_TTL_MS } from '@boite/contracts';
import type { FileContent, FileEntry, ThreadId, Timestamp } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { newToken } from './ids.ts';

/** How much of a file decides whether it is text: one NUL in there and it is not. */
export const TEXT_PROBE_BYTES = 8000;

export interface InsidePath {
  absolute: string;
  /** Relative to the working directory, forward slashes, empty for the directory itself. */
  relative: string;
}

/** The working directory of a thread that exists, which is what every path here is resolved against. */
export function threadCwd(core: Core, threadId: ThreadId): string {
  return core.threads.require(threadId).cwd;
}

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A directory that cannot be resolved is compared as it was written.
    return resolve(path);
  }
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function relativeForm(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

/**
 * A path a caller named, resolved inside the thread's working directory:
 * relative to it, or absolute as long as it stays in. Nothing is read here, so
 * a path that does not exist yet passes; `existingInside` is the one that also
 * follows the links.
 */
export function resolveInside(cwd: string, path: string, what: string): InsidePath {
  if (typeof path !== 'string') throw refused(`${what} must be a path, got ${typeof path}`, { what });
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!contains(root, absolute)) throw refused(`${what} leaves the thread's working directory: ${path}`, { what, path });
  return { absolute, relative: relativeForm(root, absolute) };
}

/**
 * The same, for something that has to be there already. The link is followed
 * before the check, so a junction inside the directory pointing outside it is
 * refused like a `..` would be.
 */
export function existingInside(
  cwd: string,
  path: string,
  expect: 'file' | 'dir',
  what: string,
): InsidePath & { stats: Stats } {
  const found = resolveInside(cwd, path, what);
  let real: string;
  let stats: Stats;
  try {
    real = realpathSync(found.absolute);
    stats = statSync(real);
  } catch {
    throw refused(`${what} does not exist: ${path}`, { what, path });
  }
  if (!contains(realOf(cwd), real)) {
    throw refused(`${what} leaves the thread's working directory: ${path}`, { what, path });
  }
  if (expect === 'file' && !stats.isFile()) throw refused(`${what} is not a file: ${path}`, { what, path });
  if (expect === 'dir' && !stats.isDirectory()) throw refused(`${what} is not a directory: ${path}`, { what, path });
  return { ...found, stats };
}

function byName(a: { name: string }, b: { name: string }): number {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * One directory, directories first. A symbolic link is listed as the file it
 * is: following every one to decide would cost a stat per entry on a tree
 * nobody asked to walk, and the link is followed when a client opens it.
 */
export async function listDirectory(cwd: string, path: string | undefined): Promise<FileEntry[]> {
  const target = existingInside(cwd, path === undefined || path.length === 0 ? '.' : path, 'dir', 'files.list path');
  const dirents = await readdir(target.absolute, { withFileTypes: true });
  const ordered = dirents
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || byName(a, b))
    .slice(0, FILES_LIST_MAX);
  return await Promise.all(
    ordered.map(async (entry): Promise<FileEntry> => {
      const full = join(target.absolute, entry.name);
      const kind = entry.isDirectory() ? 'dir' : 'file';
      let bytes: number | null = null;
      let modifiedAt = 0;
      try {
        const stats = await stat(full);
        bytes = kind === 'dir' ? null : stats.size;
        modifiedAt = Math.round(stats.mtimeMs);
      } catch {
        // A file gone or refused between the listing and the stat: named, unmeasured.
      }
      return {
        name: entry.name,
        path: target.relative.length === 0 ? entry.name : `${target.relative}/${entry.name}`,
        kind,
        bytes,
        modifiedAt,
      };
    }),
  );
}

export function hasNul(data: Uint8Array, probe = TEXT_PROBE_BYTES): boolean {
  const end = Math.min(data.length, probe);
  for (let at = 0; at < end; at += 1) if (data[at] === 0) return true;
  return false;
}

const LANGUAGES: ReadonlyMap<string, string> = new Map([
  ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'], ['json', 'json'],
  ['md', 'markdown'], ['svelte', 'svelte'], ['rs', 'rust'], ['py', 'python'], ['go', 'go'],
  ['css', 'css'], ['html', 'html'], ['yaml', 'yaml'], ['yml', 'yaml'], ['toml', 'toml'],
  ['sh', 'shell'], ['ps1', 'powershell'], ['sql', 'sql'], ['c', 'c'], ['cpp', 'cpp'],
  ['h', 'c'], ['java', 'java'], ['kt', 'kotlin'], ['rb', 'ruby'], ['php', 'php'],
  ['xml', 'xml'], ['txt', 'plaintext'],
]);

const MEDIA: ReadonlyMap<string, { kind: 'image' | 'video' | 'audio'; mime: string }> = new Map([
  ['png', { kind: 'image', mime: 'image/png' }],
  ['jpg', { kind: 'image', mime: 'image/jpeg' }],
  ['jpeg', { kind: 'image', mime: 'image/jpeg' }],
  ['gif', { kind: 'image', mime: 'image/gif' }],
  ['webp', { kind: 'image', mime: 'image/webp' }],
  ['svg', { kind: 'image', mime: 'image/svg+xml' }],
  ['bmp', { kind: 'image', mime: 'image/bmp' }],
  ['avif', { kind: 'image', mime: 'image/avif' }],
  ['ico', { kind: 'image', mime: 'image/x-icon' }],
  ['mp4', { kind: 'video', mime: 'video/mp4' }],
  ['webm', { kind: 'video', mime: 'video/webm' }],
  ['mov', { kind: 'video', mime: 'video/quicktime' }],
  ['mkv', { kind: 'video', mime: 'video/x-matroska' }],
  ['m4v', { kind: 'video', mime: 'video/x-m4v' }],
  ['mp3', { kind: 'audio', mime: 'audio/mpeg' }],
  ['wav', { kind: 'audio', mime: 'audio/wav' }],
  ['ogg', { kind: 'audio', mime: 'audio/ogg' }],
  ['flac', { kind: 'audio', mime: 'audio/flac' }],
  ['m4a', { kind: 'audio', mime: 'audio/mp4' }],
  ['aac', { kind: 'audio', mime: 'audio/aac' }],
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The highlighter's name for a file, or null when the extension says nothing. */
export function languageOf(path: string): string | null {
  return LANGUAGES.get(extensionOf(path)) ?? null;
}

/** What a file no client can read as text is: a picture, a video, a sound, or bytes. */
export function mediaOf(path: string): { kind: 'image' | 'video' | 'audio' | 'binary'; mime: string } {
  return MEDIA.get(extensionOf(path)) ?? { kind: 'binary', mime: 'application/octet-stream' };
}

/**
 * Text comes inline; everything else comes as a url. A file over
 * `FILE_MAX_BYTES` takes the url too, whatever its extension says, so a
 * gigabyte of log never becomes one JSON frame.
 */
export async function readFileContent(core: Core, cwd: string, path: string): Promise<FileContent> {
  const found = existingInside(cwd, path, 'file', 'files.read path');
  const modifiedAt = Math.round(found.stats.mtimeMs);
  if (found.stats.size <= FILE_MAX_BYTES) {
    const data = await readFile(found.absolute);
    if (!hasNul(data)) {
      // Past the cap here only by being written while it is read; the text is cut and said to be.
      const cut = data.length > FILE_MAX_BYTES;
      const text = new TextDecoder().decode(cut ? data.subarray(0, FILE_MAX_BYTES) : data);
      return {
        kind: 'text',
        path: found.relative,
        bytes: data.length,
        modifiedAt,
        text,
        truncated: cut,
        language: languageOf(found.relative),
      };
    }
  }
  const media = mediaOf(found.relative);
  const ticket = core.fileTickets.mint(found.absolute, media.mime);
  return {
    kind: media.kind,
    path: found.relative,
    bytes: found.stats.size,
    modifiedAt,
    mime: media.mime,
    // A path, not an address: the client knows which host it reached this core
    // by, and a shell driving a core elsewhere would get nothing from 127.0.0.1.
    url: `${FILE_ROUTE}/${ticket}`,
  };
}

/** The editor's save: the file may be new, its directory may not. */
export async function writeFileText(
  cwd: string,
  path: string,
  text: string,
): Promise<{ bytes: number; modifiedAt: Timestamp }> {
  if (typeof text !== 'string') throw refused(`files.write text must be a string, got ${typeof text}`, { path });
  const found = resolveInside(cwd, path, 'files.write path');
  // Named by its relative form, so a refusal never prints where the data lives.
  const parent = found.relative.includes('/') ? found.relative.slice(0, found.relative.lastIndexOf('/')) : '.';
  existingInside(cwd, parent, 'dir', 'files.write path directory');
  // The entry itself, not what it points at: a link to nothing is still there,
  // and the write would follow it and create its target wherever that is.
  let entry: Stats | null = null;
  try {
    entry = lstatSync(found.absolute);
  } catch {
    entry = null;
  }
  if (entry !== null) {
    if (entry.isSymbolicLink() && !existsSync(found.absolute)) {
      throw refused(`files.write path is a link to nothing: ${path}`, { what: 'files.write path', path });
    }
    // The write follows a link: the real file has to be inside the working directory too.
    existingInside(cwd, path, 'file', 'files.write path');
  }
  const data = new TextEncoder().encode(text);
  await writeFile(found.absolute, data);
  const stats = await stat(found.absolute);
  return { bytes: data.length, modifiedAt: Math.round(stats.mtimeMs) };
}

export interface FileTicketTarget {
  path: string;
  mime: string;
}

/**
 * The tickets the file route answers. Random, held in memory, bound to one
 * absolute path and good for `FILE_TICKET_TTL_MS`: a url that ends up in a
 * screenshot or a log opens nothing ten minutes later, and no client ever
 * names a path to the HTTP server.
 */
export class FileTickets {
  private readonly held = new Map<string, { path: string; mime: string; expiresAt: number }>();

  mint(path: string, mime: string, now = Date.now()): string {
    this.sweep(now);
    const ticket = newToken();
    this.held.set(ticket, { path, mime, expiresAt: now + FILE_TICKET_TTL_MS });
    return ticket;
  }

  resolve(ticket: string, now = Date.now()): FileTicketTarget | null {
    this.sweep(now);
    const entry = this.held.get(ticket);
    if (entry === undefined) return null;
    return { path: entry.path, mime: entry.mime };
  }

  private sweep(now: number): void {
    for (const [ticket, entry] of this.held) {
      if (entry.expiresAt <= now) this.held.delete(ticket);
    }
  }
}

export function registerWorkdirMethods(core: Core): void {
  core.router.register('files.list', (params) => listDirectory(threadCwd(core, params.threadId), params.path));
  core.router.register('files.read', (params) => readFileContent(core, threadCwd(core, params.threadId), params.path));
  // Owner only, absent from both permission maps: the agent already has its own
  // hands on the disk, and a paired phone has no business writing a file.
  core.router.register('files.write', (params) =>
    writeFileText(threadCwd(core, params.threadId), params.path, params.text),
  );
}
