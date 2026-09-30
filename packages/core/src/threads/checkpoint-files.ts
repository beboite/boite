import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { git } from '../git/read.ts';

const FILE_LIMIT = 20_000;
const BYTE_LIMIT = 128 * 1024 * 1024;
const FILE_BYTE_LIMIT = 16 * 1024 * 1024;
const SKIP = new Set(['.git', '.boite', '.agents', 'node_modules']);

export interface FileEntry { hash: string; mode: number; link?: string }
export type FileSnapshot = Record<string, FileEntry>;

export function contains(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

export function same(a: FileEntry | undefined, b: FileEntry | undefined): boolean {
  return a?.hash === b?.hash && a?.mode === b?.mode && a?.link === b?.link;
}

/** Resolve parents without following a symlink out of the checkpoint's workspace. */
export async function checkedPath(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..') || !contains(root, join(root, name))) {
    throw refused(`file checkpoint path ${name}: expected a relative path inside ${root}`, { field: 'path', path: name });
  }
  let parent = dirname(join(root, name));
  while (parent !== root) {
    try {
      if ((await lstat(parent)).isSymbolicLink()) throw refused(`file checkpoint path ${name}: parent ${parent} is a symlink`, { field: 'path', path: name });
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    parent = dirname(parent);
  }
  return join(root, name);
}

/** One file at a time, bounded before allocation. Never follows a file symlink. */
export async function readEntry(path: string): Promise<{ entry: FileEntry; bytes?: Buffer } | null> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  if (info.isDirectory()) return null;
  if (info.isSymbolicLink()) {
    const link = await readlink(path);
    return { entry: { hash: createHash('sha256').update(link).digest('hex'), mode: info.mode & 0o777, link } };
  }
  if (!info.isFile()) throw new Error(`${path}: expected a regular file or symlink`);
  if (info.size > FILE_BYTE_LIMIT) throw new Error(`${path}: file exceeds the 16 MiB checkpoint limit`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(FILE_BYTE_LIMIT + 1 > info.size ? info.size + 1 : FILE_BYTE_LIMIT + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error(`${path}: file changed while saving the checkpoint`);
    const content = bytes.subarray(0, size);
    return { entry: { hash: createHash('sha256').update(content).digest('hex'), mode: info.mode & 0o777 }, bytes: content };
  } finally { await handle.close(); }
}

/** Without git there are no reliable ignore rules; walk only bounded, ordinary project files. */
async function plainFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  let entries = 0;
  while (pending.length) {
    const parent = pending.pop()!;
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name === 'AGENTS.md' || entry.name.startsWith('.env')) continue;
      if (++entries > FILE_LIMIT) throw new Error('workspace exceeds the 20000 file checkpoint limit');
      const name = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(name);
    }
  }
  return files;
}

export async function snapshot(core: Core, threadId: string, root: string, objects: string): Promise<FileSnapshot> {
  if (contains(root, core.dataDir)) throw new Error('workspace contains the core data directory');
  const listed = await git(core, threadId, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 5000);
  const names = listed.code === 0 ? [...new Set(listed.stdout.split('\0').filter(Boolean))] : await plainFiles(root);
  if (names.length > FILE_LIMIT) throw new Error('workspace exceeds the 20000 file checkpoint limit');
  await mkdir(objects, { recursive: true, mode: 0o700 });
  const result: FileSnapshot = Object.create(null) as FileSnapshot;
  let bytes = 0;
  for (const name of names) {
    const saved = await readEntry(await checkedPath(root, name));
    if (!saved) continue;
    bytes += saved.bytes?.length ?? saved.entry.link!.length;
    if (bytes > BYTE_LIMIT) throw new Error('workspace exceeds the 128 MiB checkpoint limit');
    result[name] = saved.entry;
    if (saved.bytes) {
      try { await writeFile(join(objects, saved.entry.hash), saved.bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  return result;
}

export async function workspaceRoot(cwd: string): Promise<string> { return realpath(cwd); }

export interface FileChange { name: string; before?: FileEntry; after?: FileEntry }

async function writeEntry(root: string, objects: string, name: string, entry: FileEntry | undefined): Promise<void> {
  const path = await checkedPath(root, name);
  if (!entry) {
    await rm(path, { force: true });
    // Newly created directory trees can become files again. Only empty
    // parents are removed; unrelated content always stops the cleanup.
    let parent = dirname(path);
    while (parent !== root) {
      try { await rmdir(parent); }
      catch (error) { if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) break; throw error; }
      parent = dirname(parent);
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.boite-restore-${randomUUID()}`);
  try {
    if (entry.link !== undefined) await symlink(entry.link, temporary);
    else {
      const content = await readFile(join(objects, entry.hash));
      if (createHash('sha256').update(content).digest('hex') !== entry.hash) throw new Error(`file checkpoint blob for ${name} is corrupt`);
      await writeFile(temporary, content, { mode: entry.mode });
      await chmod(temporary, entry.mode);
    }
    // A removed directory can be replaced by a file once its affected children
    // are gone. Refuse nonempty directories instead of deleting outside files.
    try { if ((await lstat(path)).isDirectory()) await rmdir(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Check all conflicts before writing; put the original files back if a write fails. */
export async function restoreFiles(root: string, objects: string, changes: FileChange[]): Promise<void> {
  for (const change of changes) {
    const current = await readEntry(await checkedPath(root, change.name));
    if (!same(current?.entry, change.after)) {
      throw refused(`cannot rewind: ${change.name} changed outside the removed turns`, { field: 'path', path: change.name, reason: 'file-conflict', expected: 'the file state at the end of the removed turns' });
    }
    // A missing backup must be discovered before any file is touched.
    if (change.before && change.before.link === undefined) {
      const bytes = await readFile(join(objects, change.before.hash));
      if (createHash('sha256').update(bytes).digest('hex') !== change.before.hash) throw new Error(`file checkpoint blob for ${change.name} is corrupt`);
    }
  }
  const written: FileChange[] = [];
  try {
    const ordered = [...changes].sort((a, b) => Number(!!a.before) - Number(!!b.before) || a.name.split('/').length - b.name.split('/').length);
    for (const change of ordered) {
      // Recheck after asynchronous validation, immediately before its write.
      const current = await readEntry(await checkedPath(root, change.name));
      if (!same(current?.entry, change.after)) throw refused(`cannot rewind: ${change.name} changed while restoring files`, { field: 'path', path: change.name, reason: 'file-conflict' });
      await writeEntry(root, objects, change.name, change.before);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) await writeEntry(root, objects, change.name, change.after);
    throw error;
  }
}
