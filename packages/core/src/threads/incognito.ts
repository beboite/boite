import { mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { removeDir } from '../fs-retry.ts';
import { messageOf, refused } from '../errors.ts';

/**
 * Incognito conversations work under the core's own data directory, never in
 * the drafts folder the user browses: nothing they leave there outlives them.
 * One folder per thread, named after its id.
 */
export function incognitoRoot(dataDir: string): string {
  return join(dataDir, 'incognito');
}

export function makeIncognitoFolder(dataDir: string, threadId: string): string {
  const path = join(incognitoRoot(dataDir), threadId);
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw refused(`the incognito conversation's folder cannot be made: ${messageOf(error)}`, { path });
  }
  return path;
}

/** True for a folder this module made: the only kind an erase may touch. */
function insideRoot(dataDir: string, path: string): boolean {
  const inner = relative(incognitoRoot(dataDir), path);
  return inner.length > 0 && !inner.startsWith('..') && !isAbsolute(inner);
}

/** One conversation's folder, after its processes stopped. A path outside the root is left alone. */
export async function eraseIncognitoFolder(dataDir: string, path: string, log: (message: string) => void): Promise<void> {
  if (insideRoot(dataDir, path)) await removeDir(path, log);
}

/**
 * Every incognito folder at once. At startup nothing runs yet, so a folder
 * still held is one a dead core's agent kept: it is logged and left, and the
 * next start tries again.
 */
export function eraseIncognitoRoot(dataDir: string, log: (message: string) => void): void {
  try {
    rmSync(incognitoRoot(dataDir), { recursive: true, force: true });
  } catch (error) {
    log(`could not erase the incognito folders in ${incognitoRoot(dataDir)}: ${messageOf(error)}`);
  }
}
