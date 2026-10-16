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

import { constants, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FILES_LIST_MAX, FILE_MAX_BYTES, FILE_ROUTE, FILE_TICKET_TTL_MS } from '@boite/contracts';
import type { FileContent, FileEntry, ThreadId, Timestamp } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused, RpcFailure } from './errors.ts';
import type { RpcContext } from './router.ts';
import { newToken } from './ids.ts';
import { worktreeRoot } from './worktree.ts';

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

/**
 * A paired device reads a thread's tree only where the core keeps its work: the
 * thread's project, or the worktree folder the core makes for that project.
 * `threads.create` already holds a device's cwd there, but an imported or
 * owner-made thread may sit anywhere, and a link may have moved since: the
 * real path is checked again on every read, before any git or file access.
 */
export function assertDeviceReadable(core: Core, threadId: ThreadId): void {
  const thread = core.threads.require(threadId);
  const where = realOf(thread.cwd);
  if (!deviceRoots(core, threadId).some((root) => contains(root, where))) {
    throw refused(`a paired device reads only inside the thread's project or its worktrees, not ${thread.cwd}`, { threadId });
  }
}

function deviceRoots(core: Core, threadId: ThreadId): string[] {
  const thread = core.threads.require(threadId);
  const project = thread.projectId === null ? null : core.projects.require(thread.projectId);
  // The in-project worktree folder is inside the project; a shared one is not.
  const roots = project === null ? [] : [project.path, worktreeRoot(project.path, core.settings.get().worktreeStorage, project.id)];
  return roots.map(realOf);
}

/** Folders that hold keys or tokens wherever they sit in a tree. */
const DEVICE_SECRET_DIRS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']);
/** Files that hold credentials; templates such as `.env.example` stay readable. */
const DEVICE_SECRET_FILE =
  /^(\.env(\.(?!example$|sample$|template$)[^.]+)*|\.envrc|\.dev\.vars|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|\.credentials\.json|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(tfvars|tfstate|tfstate\.backup)|.+\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;

/**
 * Inside a readable tree, a paired device still leaves two things to the owner.
 * The core's own data (journal, accounts, tokens) when a project contains it,
 * which happens when a project is a home or desktop folder; a project or
 * worktree folder kept under the data folder stays readable. And files that
 * hold credentials, since a phone that is lost or borrowed should not carry a
 * key away. A path outside the tree is left to the read itself to refuse.
 */
export function assertDeviceFile(core: Core, threadId: ThreadId, cwd: string, path: string | undefined): void {
  const base = realOf(cwd);
  const target = realOf(resolve(cwd, path ?? ''));
  if (!contains(base, target)) return;
  const data = realOf(core.dataDir);
  if (contains(data, target) && !deviceRoots(core, threadId).some((root) => root !== data && contains(data, root) && contains(root, target))) {
    throw refused(`a paired device does not read boite's data folder: ${path ?? ''}`, { threadId });
  }
  const parts = relative(base, target).split(sep).filter(Boolean);
  if (parts.some((part) => DEVICE_SECRET_DIRS.has(part.toLowerCase())) || DEVICE_SECRET_FILE.test(basename(target))) {
    throw refused(`a paired device does not read credential files; open ${path ?? ''} on the owner's machine`, { threadId });
  }
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
): InsidePath & { stats: Stats; real: string } {
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
  return { ...found, real, stats };
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset);
    if (bytesWritten <= 0) throw refused('the file write made no progress');
    offset += bytesWritten;
  }
}

/** Open the real directory checked a moment ago. The handle stays on that inode if its path is renamed. */
export async function openHeldDirectory(real: string, dev: number, ino: number, what: string, path: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch {
    throw refused(`${what} changed while it was opened: ${path}`, { what, path });
  }
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory() || stats.dev !== dev || stats.ino !== ino) {
      throw refused(`${what} changed while it was opened: ${path}`, { what, path });
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Create `name` inside a directory the caller holds. On Linux the new file is
 * opened through that inode, so renaming the directory onto an outside link
 * cannot redirect it. Elsewhere the fallback path is opened after the inode
 * check; a swap in that gap can still create the file outside.
 */
export async function createExclusiveFile(dir: FileHandle, name: string, fallbackPath: string): Promise<FileHandle> {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw refused(`files.write path is not a file name: ${name}`, { what: 'files.write path', path: name });
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
  const target = process.platform === 'linux' ? `/proc/self/fd/${dir.fd}/${name}` : fallbackPath;
  return open(target, flags, 0o666);
}

/** Open the real file checked a moment ago, and refuse a symlink swapped in since. */
export async function openChecked(real: string, flags: number, dev: number, ino: number, what: string, path: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(real, flags | NOFOLLOW);
  } catch {
    throw refused(`${what} changed while it was opened: ${path}`, { what, path });
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== dev || stats.ino !== ino) {
      throw refused(`${what} changed while it was opened: ${path}`, { what, path });
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Whether a write to `path` would land inside the working directory once every
 * link on the way is followed. A file that does not exist yet is judged by its
 * nearest existing parent, which is where the write would create it; a link to
 * nothing, or a path that cannot be read, is judged outside.
 */
export function writeLandsInside(cwd: string, path: string): boolean {
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!contains(root, absolute)) return false;
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      return contains(realOf(root), join(realpathSync(probe), ...missing));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      try {
        lstatSync(probe);
        return false;
      } catch {
        // Not there at all: its parent decides.
      }
      const parent = dirname(probe);
      if (parent === probe) return false;
      missing.unshift(basename(probe));
      probe = parent;
    }
  }
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
  if (extensionOf(path) === 'pdf') return { kind: 'binary', mime: 'application/pdf' };
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
  const media = mediaOf(found.relative);
  const handle = await openChecked(found.real, constants.O_RDONLY, found.stats.dev, found.stats.ino, 'files.read path', path);
  let ticketIdentity: string | null = null;
  try {
    if (found.stats.size <= FILE_MAX_BYTES && media.mime === 'application/octet-stream') {
      const data = Buffer.alloc(found.stats.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const read = data.subarray(0, offset);
      if (!hasNul(read)) {
        const cut = read.length > FILE_MAX_BYTES;
        const text = new TextDecoder().decode(cut ? read.subarray(0, FILE_MAX_BYTES) : read);
        return {
          kind: 'text',
          path: found.relative,
          bytes: read.length,
          modifiedAt,
          text,
          truncated: cut,
          language: languageOf(found.relative),
        };
      }
    }
    const held = await handle.stat({ bigint: true });
    ticketIdentity = `${found.real}|${held.dev}|${held.ino}|${held.size}|${held.mtimeNs}|${held.ctimeNs}`;
  } finally {
    await handle.close();
  }
  if (ticketIdentity === null) throw refused(`files.read path changed while it was opened: ${path}`, { what: 'files.read path', path });
  // The identity comes from the handle, not a second walk. A parent swapped
  // before mint would otherwise bind the ticket to the new file.
  const ticket = core.fileTickets.mint(found.real, media.mime, Date.now(), basename(found.absolute), ticketIdentity);
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
  const parentInside = existingInside(cwd, parent, 'dir', 'files.write path directory');
  // The entry itself, not what it points at: a link to nothing is still there,
  // and the write would follow it and create its target wherever that is.
  let entry: Stats | null = null;
  try {
    entry = lstatSync(found.absolute);
  } catch {
    entry = null;
  }
  const data = new TextEncoder().encode(text);
  if (entry !== null) {
    if (entry.isSymbolicLink() && !existsSync(found.absolute)) {
      throw refused(`files.write path is a link to nothing: ${path}`, { what: 'files.write path', path });
    }
    // The write follows a link: the real file has to be inside the working directory too.
    const inside = existingInside(cwd, path, 'file', 'files.write path');
    // Truncate only after the inode matches. Windows Bun 1.4.2 returns EINVAL
    // for O_WRONLY|O_TRUNC on an ordinary file, and truncating first would
    // also shorten a file the check then refuses.
    const handle = await openChecked(inside.real, constants.O_WRONLY, inside.stats.dev, inside.stats.ino, 'files.write path', path);
    try {
      await handle.truncate(0);
      await writeAll(handle, data);
    } finally {
      await handle.close();
    }
  } else {
    // Create the name in the held parent inode. O_EXCL plus O_NOFOLLOW still
    // refuses a symlink that appears at that name. On Linux the create goes
    // through the directory fd, so a parent renamed onto an outside link
    // cannot receive the bytes. Other platforms open the path after this
    // inode check; a swap in that gap can still create the file outside.
    const dir = await openHeldDirectory(parentInside.real, parentInside.stats.dev, parentInside.stats.ino, 'files.write path directory', path);
    try {
      let handle: FileHandle;
      try {
        handle = await createExclusiveFile(dir, basename(found.absolute), join(parentInside.real, basename(found.absolute)));
      } catch (error) {
        if (error instanceof RpcFailure) throw error;
        throw refused(`files.write path changed while it was opened: ${path}`, { what: 'files.write path', path });
      }
      try {
        await writeAll(handle, data);
      } finally {
        await handle.close();
      }
    } finally {
      await dir.close();
    }
  }
  const stats = await stat(found.absolute);
  return { bytes: data.length, modifiedAt: Math.round(stats.mtimeMs) };
}

export interface FileTicketTarget {
  path: string;
  mime: string;
  name?: string;
  /** A published view: the one kind of ticket `VIEW_ROUTE` opens as a page. Any other only downloads. */
  view?: true;
}

function fileIdentity(path: string): string | null {
  try {
    const real = realpathSync(path);
    const stats = statSync(real, { bigint: true });
    if (!stats.isFile()) return null;
    return `${real}|${stats.dev}|${stats.ino}|${stats.size}|${stats.mtimeNs}|${stats.ctimeNs}`;
  } catch { return null; }
}

/**
 * The tickets the file route answers. Random, held in memory, bound to one
 * absolute path and good for `FILE_TICKET_TTL_MS`: a url that ends up in a
 * screenshot or a log opens nothing ten minutes later, and no client ever
 * names a path to the HTTP server.
 */
export class FileTickets {
  private readonly held = new Map<string, FileTicketTarget & { expiresAt: number; identity: string | null }>();

  mint(path: string, mime: string, now = Date.now(), name?: string, identity?: string, view = false): string {
    this.sweep(now);
    const ticket = newToken();
    this.held.set(ticket, {
      path,
      mime,
      ...(name ? { name } : {}),
      ...(view ? { view: true as const } : {}),
      expiresAt: now + FILE_TICKET_TTL_MS,
      identity: identity ?? fileIdentity(path),
    });
    return ticket;
  }

  /** Only an authenticated artifact read can keep its own URL alive during playback. */
  renew(ticket: string, path: string, now = Date.now()): boolean {
    const target = this.resolve(ticket, now);
    if (!target || target.path !== path) return false;
    this.held.get(ticket)!.expiresAt = now + FILE_TICKET_TTL_MS;
    return true;
  }

  resolve(ticket: string, now = Date.now()): FileTicketTarget | null {
    this.sweep(now);
    const entry = this.held.get(ticket);
    if (entry === undefined) return null;
    if (entry.identity === null || fileIdentity(entry.path) !== entry.identity) {
      this.held.delete(ticket);
      return null;
    }
    return { path: entry.path, mime: entry.mime, ...(entry.name ? { name: entry.name } : {}), ...(entry.view ? { view: true as const } : {}) };
  }

  /** Drop every ticket. A revoked session must not keep a bearer URL alive. */
  forgetAll(): void {
    this.held.clear();
  }

  /** Drop tickets for files under `root`. Artifact tickets live outside a project cwd, so they stay. */
  forgetUnder(root: string): void {
    const base = realOf(root);
    for (const [ticket, entry] of this.held) {
      if (contains(base, realOf(entry.path))) this.held.delete(ticket);
    }
  }

  /**
   * Open the ticket's file without following a symlink swapped in after the
   * mint. The handle is the caller's to close. A mismatch drops the ticket.
   */
  async open(ticket: string, now = Date.now()): Promise<{ handle: FileHandle; mime: string; name?: string; size: number; view?: true } | null> {
    this.sweep(now);
    const entry = this.held.get(ticket);
    if (entry === undefined || entry.identity === null) {
      if (entry !== undefined) this.held.delete(ticket);
      return null;
    }
    let handle: FileHandle;
    try {
      handle = await open(entry.path, constants.O_RDONLY | NOFOLLOW);
    } catch {
      this.held.delete(ticket);
      return null;
    }
    try {
      const stats = await handle.stat({ bigint: true });
      // The stored identity leads with the real path. Comparing the fstat tail
      // still rejects a swapped inode, including when the ticket named a link.
      const suffix = `|${stats.dev}|${stats.ino}|${stats.size}|${stats.mtimeNs}|${stats.ctimeNs}`;
      if (!stats.isFile() || suffix.length >= entry.identity.length || !entry.identity.endsWith(suffix)) {
        this.held.delete(ticket);
        await handle.close();
        return null;
      }
      return { handle, mime: entry.mime, ...(entry.name ? { name: entry.name } : {}), size: Number(stats.size), ...(entry.view ? { view: true as const } : {}) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private sweep(now: number): void {
    for (const [ticket, entry] of this.held) {
      if (entry.expiresAt <= now) this.held.delete(ticket);
    }
  }
}

/** The working directory a read is resolved against, held to the project for a paired device. */
export function readCwd(core: Core, threadId: ThreadId, ctx: RpcContext, path?: string): string {
  const cwd = threadCwd(core, threadId);
  if (ctx.connection.identity.principal === 'session') {
    assertDeviceReadable(core, threadId);
    assertDeviceFile(core, threadId, cwd, path);
  }
  return cwd;
}

export function registerWorkdirMethods(core: Core): void {
  core.router.register('files.list', (params, ctx) => listDirectory(readCwd(core, params.threadId, ctx, params.path), params.path));
  core.router.register('files.read', (params, ctx) => readFileContent(core, readCwd(core, params.threadId, ctx, params.path), params.path));
  // Owner only, absent from both permission maps: the agent already has its own
  // hands on the disk, and a paired phone has no business writing a file.
  core.router.register('files.write', (params) =>
    writeFileText(threadCwd(core, params.threadId), params.path, params.text),
  );
}
