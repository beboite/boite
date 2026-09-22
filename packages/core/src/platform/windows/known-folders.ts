/**
 * The user's Documents folder as Explorer shows it. `%USERPROFILE%\Documents`
 * is only the default: OneDrive and a moved library both redirect it, and
 * `SHGetKnownFolderPath` is the one answer that follows them.
 */
import { dlopen, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';

/** FOLDERID_Documents, {FDD39AD0-238F-46AF-ADB4-6C85480369C7}, laid out as a GUID struct. */
function documentsId(): Uint8Array {
  const guid = new Uint8Array(16);
  const view = new DataView(guid.buffer);
  view.setUint32(0, 0xfdd39ad0, true);
  view.setUint16(4, 0x238f, true);
  view.setUint16(6, 0x46af, true);
  guid.set([0xad, 0xb4, 0x6c, 0x85, 0x48, 0x03, 0x69, 0xc7], 8);
  return guid;
}

/** The longest path Windows hands out, in UTF-16 units, so a bad pointer cannot walk forever. */
const MAX_PATH_UNITS = 32_767;

/** Null when the shell cannot say, which the caller answers with the default. */
export function documentsFolder(): string | null {
  const shell32 = dlopen('shell32.dll', {
    SHGetKnownFolderPath: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const ole32 = dlopen('ole32.dll', {
    CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
  });
  try {
    const guid = documentsId();
    const out = new BigUint64Array(1);
    const result = shell32.symbols.SHGetKnownFolderPath(ptr(guid), 0, null, ptr(out));
    const address = Number(out[0]) as Pointer;
    if (result !== 0 || address === 0) {
      if (address !== 0) ole32.symbols.CoTaskMemFree(address);
      return null;
    }
    let units = 0;
    while (units < MAX_PATH_UNITS && read.u16(address, units * 2) !== 0) units += 1;
    const path = Buffer.from(toArrayBuffer(address, 0, units * 2)).toString('utf16le');
    ole32.symbols.CoTaskMemFree(address);
    return path.length > 0 ? path : null;
  } finally {
    shell32.close();
    ole32.close();
  }
}
