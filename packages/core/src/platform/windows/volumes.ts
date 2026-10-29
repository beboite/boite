import { statfsSync } from 'node:fs';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { MachineVolume } from '@boite/contracts';

const DRIVE_FIXED = 3;

function loadKernel32() {
  return dlopen('kernel32.dll', {
    GetLogicalDrives: { args: [], returns: FFIType.u32 },
    GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
  });
}

let kernel32: ReturnType<typeof loadKernel32>['symbols'] | null = null;

/** Fixed drives by letter. Removable, network, optical and RAM drives are left out. */
export function machineVolumes(): MachineVolume[] {
  try {
    kernel32 ??= loadKernel32().symbols;
    const mask = kernel32.GetLogicalDrives();
    const volumes: MachineVolume[] = [];
    for (let bit = 0; bit < 26; bit++) {
      if ((mask & (1 << bit)) === 0) continue;
      const root = `${String.fromCharCode(65 + bit)}:\\`;
      if (kernel32.GetDriveTypeW(ptr(new Uint8Array(Buffer.from(`${root}\0`, 'utf16le')))) !== DRIVE_FIXED) continue;
      try {
        const stats = statfsSync(root);
        const totalBytes = stats.blocks * stats.bsize;
        if (totalBytes > 0) volumes.push({ name: root.slice(0, 2), totalBytes, freeBytes: stats.bavail * stats.bsize });
      } catch {
        // A locked BitLocker volume or a drive that went away between the two calls.
      }
    }
    return volumes;
  } catch {
    return [];
  }
}
