import { currentOs } from '../paths.ts';
import { createPosixPlatform } from './posix.ts';
import type { ProcessPlatform } from './types.ts';
import { scopedPlatforms } from './scoped.ts';

// Each native backend loads only on its own OS. Linux imports bun:ffi only
// with the first `boite window` on an X11 session (posix.ts).
const os = currentOs();
export const processPlatform: ProcessPlatform = os === 'windows'
  ? (await import('./windows/index.ts')).platform
  : createPosixPlatform(os, os === 'macos' ? new (await import('./macos-memory.ts')).MacMemory() : undefined);

export const registryPlatform: () => ProcessPlatform = os === 'windows' ? scopedPlatforms(processPlatform) : () => processPlatform;
