import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { currentOs } from '../paths.ts';

// Linux and macOS never evaluate the Windows module or import bun:ffi. On
// Windows the module only declares; shell32 opens on the first call.
const known = currentOs() === 'windows' ? await import('./windows/known-folders.ts') : null;

/**
 * The user's Documents folder on the machine running the core. Windows asks
 * the shell, which follows OneDrive and a moved library (3 ms, 2026-09-23);
 * Linux reads the XDG user dirs file the desktop writes; macOS and anything
 * unreadable fall back to `~/Documents`.
 */
export function documentsDir(): string {
  const os = currentOs();
  if (known !== null) return known.documentsFolder() ?? join(homedir(), 'Documents');
  if (os === 'linux') return xdgDocuments() ?? join(homedir(), 'Documents');
  return join(homedir(), 'Documents');
}

/** `XDG_DOCUMENTS_DIR="$HOME/Dokumente"` out of `user-dirs.dirs`, `$HOME` expanded. */
export function xdgDocuments(configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')): string | null {
  let text: string;
  try {
    text = readFileSync(join(configHome, 'user-dirs.dirs'), 'utf8');
  } catch {
    return null;
  }
  const line = /^XDG_DOCUMENTS_DIR="([^"]*)"/m.exec(text);
  if (line === null) return null;
  const value = (line[1] ?? '').replace(/^\$HOME(?=\/|$)/, homedir());
  // A value set to the home itself means the desktop turned the folder off.
  return isAbsolute(value) && resolve(value) !== resolve(homedir()) ? value : null;
}
