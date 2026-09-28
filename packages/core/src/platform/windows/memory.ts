import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { ProcessPlatform } from '../types.ts';

function loadKernel32() {
  return dlopen('kernel32.dll', {
    GlobalMemoryStatusEx: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
}

let kernel32: ReturnType<typeof loadKernel32> | null = null;

/** Physical memory, including pages Windows can make available without paging out. */
export const machineMemory: ProcessPlatform['machineMemory'] = () => {
  try {
    kernel32 ??= loadKernel32();
    // MEMORYSTATUSEX: length and load are DWORDs, followed by seven DWORDLONGs.
    const buffer = new Uint8Array(64);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, buffer.byteLength, true);
    if (kernel32.symbols.GlobalMemoryStatusEx(ptr(buffer)) === 0) return null;
    return { totalBytes: Number(view.getBigUint64(8, true)), availableBytes: Number(view.getBigUint64(16, true)) };
  } catch {
    return null;
  }
};
