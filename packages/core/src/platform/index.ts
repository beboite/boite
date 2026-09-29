import { currentOs } from '../paths.ts';
import { createPosixPlatform } from './posix.ts';
import type { ProcessPlatform } from './types.ts';

// Each native backend loads only on its own OS. Linux never imports bun:ffi.
const os = currentOs();
export const processPlatform: ProcessPlatform = os === 'windows'
  ? (await import('./windows/index.ts')).platform
  : createPosixPlatform(os, os === 'macos' ? new (await import('./macos-memory.ts')).MacMemory() : undefined);
