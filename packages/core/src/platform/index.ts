import { currentOs } from '../paths.ts';
import { createPosixPlatform } from './posix.ts';
import { posixLockFile } from './posix-file-lock.ts';
import type { FileLocker, ProcessPlatform } from './types.ts';
import { scopedPlatforms } from './scoped.ts';

// Each native backend loads only on its own OS. Linux imports bun:ffi at
// startup for the data lock's flock alone (posix-file-lock.ts), and libX11
// with the first `boite window` on an X11 session (posix.ts).
const os = currentOs();
export const processPlatform: ProcessPlatform = os === 'windows'
  ? (await import('./windows/index.ts')).platform
  : createPosixPlatform(os, os === 'macos' ? new (await import('./macos-memory.ts')).MacMemory() : undefined);

export const registryPlatform: () => ProcessPlatform = os === 'windows' ? scopedPlatforms(processPlatform) : () => processPlatform;

/** The OS-held file lock behind the data-directory and maintenance locks. */
export const lockFile: FileLocker = os === 'windows'
  ? (await import('./windows/file-lock.ts')).windowsLockFile
  : posixLockFile(os);
