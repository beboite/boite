import {dlopen, FFIType, ptr} from 'bun:ffi';
import type {ProcessRecord} from '@boite/contracts';

/** Observe remaining records without retiring them or granting publication.
 * A newly opened PID may be a replacement; keep both creation identities. */
export function publicationState(records: ProcessRecord[]) {
  if (!records.length) return [];
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: {args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr},
    GetProcessTimes: {args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
    GetExitCodeProcess: {args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
    WaitForSingleObject: {args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32},
    QueryFullProcessImageNameW: {args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
    GetLastError: {args: [], returns: FFIType.u32},
    CloseHandle: {args: [FFIType.ptr], returns: FFIType.i32},
  });
  try {
    return records.map(record => {
      const {pid, parentPid, exe, startedAt} = record;
      const handle = kernel.symbols.OpenProcess(0x101000, 0, pid);
      const openError = handle ? 0 : kernel.symbols.GetLastError();
      if (!handle) return {pid, parentPid, exe, startedAt, openError};
      const result: Record<string, unknown> = {pid, parentPid, exe, startedAt, openError};
      try {
        const times = Buffer.alloc(32), exit = Buffer.alloc(4), image = Buffer.alloc(65536), size = Buffer.alloc(4);
        size.writeUInt32LE(image.length / 2);
        const timed = kernel.symbols.GetProcessTimes(handle, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24));
        result.timesError = timed ? 0 : kernel.symbols.GetLastError();
        result.creationFileTime = timed ? times.readBigUInt64LE().toString() : null;
        result.creationValid = !!timed && times.readBigUInt64LE() > 116444736000000000n;
        result.creationUnixMs = result.creationValid ? Number((times.readBigUInt64LE() - 116444736000000000n) / 10000n) : null;
        const read = kernel.symbols.GetExitCodeProcess(handle, ptr(exit));
        result.exitError = read ? 0 : kernel.symbols.GetLastError(); result.exitCode = read ? exit.readUInt32LE() : null;
        result.wait = kernel.symbols.WaitForSingleObject(handle, 0);
        result.waitError = result.wait === 0xffffffff ? kernel.symbols.GetLastError() : 0;
        const named = kernel.symbols.QueryFullProcessImageNameW(handle, 0, ptr(image), ptr(size));
        result.imageError = named ? 0 : kernel.symbols.GetLastError();
        result.image = named ? image.toString('utf16le', 0, size.readUInt32LE() * 2) : null;
      } finally {
        result.closed = !!kernel.symbols.CloseHandle(handle);
        result.closeError = result.closed ? 0 : kernel.symbols.GetLastError();
      }
      return result;
    });
  } finally {kernel.close();}
}
