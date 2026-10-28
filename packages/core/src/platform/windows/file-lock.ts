import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { HeldFileLock } from '../types.ts';

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_READ_ATTRIBUTES = 0x80;
/** Read, write and delete stay shared: the holder's record is read and rewritten by path, and released by deletion. */
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
const ERROR_LOCK_VIOLATION = 33;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
/**
 * The locked byte lies far past any record, so reading and rewriting the
 * record by path never touches it: Windows enforces byte-range locks on reads.
 */
const LOCKED_OFFSET_HIGH = 0x4000_0000;

function loadKernel32() {
  return dlopen('kernel32.dll', {
    // Handles travel as u64: INVALID_HANDLE_VALUE is all ones, past what a number holds exactly.
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
    LockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
}
let kernel32: ReturnType<typeof loadKernel32>['symbols'] | undefined;

function open(path: string, access: number, disposition: number): bigint | null {
  const wide = new Uint8Array(Buffer.from(`${path}\0`, 'utf16le'));
  const handle = kernel32!.CreateFileW(ptr(wide), access, FILE_SHARE_ALL, null, disposition, FILE_ATTRIBUTE_NORMAL, null);
  return handle === 0n || handle === INVALID_HANDLE_VALUE ? null : handle;
}

/** Volume serial and 64-bit file index from BY_HANDLE_FILE_INFORMATION, or null when unreadable. */
function identity(handle: bigint): string | null {
  const info = new Uint8Array(52);
  if (kernel32!.GetFileInformationByHandle(handle, ptr(info)) === 0) return null;
  const view = new DataView(info.buffer);
  return `${view.getUint32(28, true)}:${view.getUint32(44, true)}:${view.getUint32(48, true)}`;
}

/**
 * An exclusive `LockFileEx` on one byte of `file`, created if missing. The
 * system drops it when the handle closes or the holder dies, so it is never
 * stale. Null while another handle holds it, one of this process included.
 */
export function windowsLockFile(file: string): HeldFileLock | null {
  kernel32 ??= loadKernel32().symbols;
  const handle = open(file, GENERIC_READ | GENERIC_WRITE, OPEN_ALWAYS);
  if (handle === null) throw new Error(`could not open ${file} to lock it: error ${kernel32.GetLastError()}`);
  // OVERLAPPED: Internal, InternalHigh, Offset at 16, OffsetHigh at 20, hEvent.
  const overlapped = new Uint8Array(32);
  new DataView(overlapped.buffer).setUint32(20, LOCKED_OFFSET_HIGH, true);
  if (kernel32.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ptr(overlapped)) === 0) {
    const code = kernel32.GetLastError();
    kernel32.CloseHandle(handle);
    if (code === ERROR_LOCK_VIOLATION) return null;
    throw new Error(`could not lock ${file}: LockFileEx failed with error ${code}`);
  }
  const id = identity(handle);
  let held = true;
  return {
    stillAt(path) {
      if (!held || id === null) return false;
      // A deleted file still open elsewhere refuses to open: it is not at the path either.
      const other = open(path, FILE_READ_ATTRIBUTES, OPEN_EXISTING);
      if (other === null) return false;
      try { return identity(other) === id; } finally { kernel32!.CloseHandle(other); }
    },
    release() {
      if (!held) return;
      held = false;
      kernel32!.CloseHandle(handle);
    },
  };
}
