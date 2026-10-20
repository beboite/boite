import { dlopen, FFIType, ptr } from 'bun:ffi';

let answer: boolean | undefined;

/** `kern.hv_vmm_present`, or null when the kernel does not answer. */
function readHypervisor(): number | null {
  const libc = dlopen('/usr/lib/libSystem.B.dylib', {
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  try {
    const value = new Int32Array(1), size = new BigUint64Array([4n]);
    const name = new TextEncoder().encode('kern.hv_vmm_present\0');
    return libc.symbols.sysctlbyname(ptr(name), ptr(value), ptr(size), null, 0) === 0 ? value[0]! : null;
  } finally { libc.close(); }
}

/**
 * Whether this Mac runs in a virtual machine, as a CI runner does: the kernel
 * sets `kern.hv_vmm_present` to 1 under a hypervisor and 0 on a Mac's own
 * hardware. Read once; a Mac that cannot say counts as hardware.
 */
export function macVirtualMachine(): boolean {
  if (answer !== undefined) return answer;
  try { answer = readHypervisor() === 1; } catch { answer = false; }
  return answer;
}
