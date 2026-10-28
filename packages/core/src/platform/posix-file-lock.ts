import { closeSync, fstatSync, ftruncateSync, openSync, statSync, writeSync } from 'node:fs';
import type { HeldFileLock } from './types.ts';

const LOCK_EX = 2;
const LOCK_NB = 4;

interface Libc {
  flock(handle: number, operation: number): number;
  errno(): number;
  /** EWOULDBLOCK, which differs between Linux and macOS. */
  busy: number;
}
let libc: Libc | undefined;

function load(os: 'linux' | 'macos'): Libc {
  // Loaded on first use, by the first lock taken: the data lock at startup or a server update's.
  const { dlopen, FFIType, read } = import.meta.require('bun:ffi') as typeof import('bun:ffi');
  const errno = os === 'linux' ? '__errno_location' : '__error';
  const { symbols } = dlopen(os === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errno]: { args: [], returns: FFIType.ptr },
  });
  const location = symbols[errno] as () => import('bun:ffi').Pointer | null;
  return {
    flock: (handle, operation) => symbols.flock(handle, operation),
    errno: () => { const at = location(); return at === null ? 0 : read.i32(at, 0); },
    busy: os === 'linux' ? 11 : 35,
  };
}

/**
 * `flock(2)` on an open descriptor of `file`, created if missing. The kernel
 * holds it for that descriptor and drops it when the holder exits, killed
 * included, so it is never stale and no second holder can read it
 * half-written. Null while another descriptor holds it, one of this process
 * included; any other failure throws.
 */
export function posixLockFile(os: 'linux' | 'macos'): (file: string) => HeldFileLock | null {
  return (file) => {
    libc ??= load(os);
    const handle = openSync(file, 'a', 0o600);
    if (libc.flock(handle, LOCK_EX | LOCK_NB) !== 0) {
      const code = libc.errno();
      closeSync(handle);
      if (code === libc.busy) return null;
      throw new Error(`could not lock ${file}: flock failed with errno ${code}`);
    }
    const { dev, ino } = fstatSync(handle, { bigint: true });
    let open = true;
    return {
      stillAt(path) {
        if (!open) return false;
        try {
          const at = statSync(path, { bigint: true });
          return at.dev === dev && at.ino === ino;
        } catch { return false; }
      },
      write(text) {
        // Opened for append: once truncated, the write lands at the start.
        ftruncateSync(handle, 0);
        writeSync(handle, text);
      },
      release() {
        if (!open) return;
        open = false;
        closeSync(handle);
      },
    };
  };
}
