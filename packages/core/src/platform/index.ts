import { currentOs } from '../paths.ts';
import { createPosixPlatform } from './posix.ts';
import type { ProcessPlatform } from './types.ts';

// Linux/macOS never evaluate the Windows modules or import bun:ffi.
const os = currentOs();
export const processPlatform: ProcessPlatform = os === 'windows'
  ? (await import('./windows/index.ts')).platform
  : createPosixPlatform(os);
