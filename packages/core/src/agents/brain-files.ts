/**
 * Reads and writes of the files of an agent's brain (AGENTS.md, MEMORY.md,
 * `memories-archive.md`). A brain is the agent's own: a link in it, on the
 * file or on any folder from the brains' root down, could send a read or a
 * write into another agent's brain or any file of the user, so it is refused.
 * The file itself opens without following a link where the platform has
 * `O_NOFOLLOW`; a rewrite goes through a fresh temporary file only this call
 * can have created, renamed over the file.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { refused } from '../errors.ts';

/** Zero where the platform has no such flag (Windows): the `lstat` checks still hold there. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The refusal of a link: `at` is the link, `path` the file asked for. */
function linked(path: string, at: string): never {
  const where = at === path ? 'it is a symbolic link' : `its folder ${at} is a symbolic link`;
  throw refused(`${path}: refused, ${where}; an agent's brain holds its own files only, so replace the link with the file or folder itself`, { path, field: 'path', expected: 'a regular file inside the brain, with no link on the way' });
}

/**
 * Refuses `path` when it, or a folder between `root` and it, is a link, or
 * when it exists and is not a regular file (a folder with `folder`). A part
 * that does not exist yet is no link: the brain creates it.
 */
export function checkBrainPath(root: string, path: string, folder = false): void {
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refused(`${path}: refused, it is not inside the brains' folder ${root}`, { path, field: 'path' });
  let at = root;
  for (const part of ['', ...rel.split(sep)]) {
    at = part ? join(at, part) : at;
    let stat;
    try { stat = lstatSync(at); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) linked(path, at);
    if (at !== path && !stat.isDirectory()) throw refused(`${path}: refused, ${at} is not a folder`, { path, field: 'path' });
    if (at === path && (folder ? !stat.isDirectory() : !stat.isFile())) throw refused(`${path}: refused, it is not a ${folder ? 'folder' : 'regular file'}`, { path, field: 'path' });
  }
}

/** Opens the file, never through a link, and checks the handle is a regular file. */
function open(root: string, path: string, flags: number, mode?: number): number {
  checkBrainPath(root, path);
  let fd: number;
  try { fd = openSync(path, flags | NOFOLLOW, mode); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') linked(path, path);
    throw error;
  }
  if (!fstatSync(fd).isFile()) { closeSync(fd); throw refused(`${path}: refused, it is not a regular file`, { path, field: 'path' }); }
  return fd;
}

export function readBrainFile(root: string, path: string): string {
  const fd = open(root, path, constants.O_RDONLY);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}

export function appendBrainFile(root: string, path: string, text: string): void {
  const fd = open(root, path, constants.O_WRONLY | constants.O_APPEND);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/** A new file only: refused when anything, a link included, already holds the name. */
export function createBrainFile(root: string, path: string, text: string): void {
  const fd = open(root, path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/** The whole file again: written to an unpredictable temporary file created here, then renamed over it. */
export function rewriteBrainFile(root: string, path: string, text: string): void {
  checkBrainPath(root, path);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`);
  createBrainFile(root, temp, text);
  try {
    // Checked again: a link planted while the temporary file was written is refused too.
    checkBrainPath(root, path);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
