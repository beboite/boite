/**
 * What the core reads from one process handle: name, parent, command line, exit
 * code, CPU time, memory and I/O. Plain reads over whatever Win32 surface is
 * passed in, so the job lifecycle in jobs.ts keeps only its own state.
 */

/** The handle reads jobs.ts's native surface offers. */
export interface ProcessReads {
  hasNt: boolean;
  imageName(proc: number, buffer: Uint16Array, size: Uint32Array): boolean;
  basicInfo(proc: number, out: Uint8Array): boolean;
  readMemory(proc: number, address: bigint, into: Uint8Array): boolean;
  exitCode(proc: number, out: Uint32Array): boolean;
  processTimes(proc: number, out: Uint8Array): boolean;
  ioCounters(proc: number, out: Uint8Array): boolean;
  memoryInfo(proc: number, out: Uint8Array): boolean;
}

/** GetExitCodeProcess's answer for a process still running. */
const STILL_ACTIVE = 259;

// -- Struct offsets, all x64 ------------------------------------------------

/** PROCESS_BASIC_INFORMATION.InheritedFromUniqueProcessId. UniqueProcessId sits at 32. */
const OFF_INHERITED_FROM = 40;
const PROCESS_BASIC_INFORMATION_SIZE = 48;
/** PROCESS_BASIC_INFORMATION.PebBaseAddress. */
const OFF_PEB_BASE = 8;
/** PEB.ProcessParameters. */
const OFF_PROCESS_PARAMETERS = 0x20;
/** RTL_USER_PROCESS_PARAMETERS.CommandLine, a UNICODE_STRING (Length u16, Buffer at +8). */
const OFF_COMMAND_LINE = 0x70;
/** PROCESS_MEMORY_COUNTERS: cb, PageFaultCount, then eight SIZE_T fields. */
const PROCESS_MEMORY_COUNTERS_SIZE = 72;
const OFF_PEAK_WORKING_SET = 8;
const OFF_WORKING_SET = 16;
/** IO_COUNTERS: six u64, the three operation counts then the three transfer counts. */
const IO_COUNTERS_SIZE = 48;
const OFF_READ_TRANSFER = 24;
const OFF_WRITE_TRANSFER = 32;
/** GetProcessTimes writes four FILETIMEs; kernel is the third, user the fourth. */
const OFF_KERNEL_TIME = 16;
const OFF_USER_TIME = 24;
/** The longest command line Windows accepts, so anything past it is a bad read. */
const MAX_COMMAND_LINE_BYTES = 32768;

export function imageNameOf(api: ProcessReads, handle: number): string | null {
  const buffer = new Uint16Array(520);
  const size = new Uint32Array([buffer.length]);
  if (!api.imageName(handle, buffer, size)) return null;
  const length = size[0] ?? 0;
  if (length === 0) return null;
  return Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
}

export function parentPidOf(api: ProcessReads, handle: number): number | null {
  if (!api.hasNt) return null;
  const buffer = new Uint8Array(PROCESS_BASIC_INFORMATION_SIZE);
  if (!api.basicInfo(handle, buffer)) return null;
  const parent = Number(new DataView(buffer.buffer).getBigUint64(OFF_INHERITED_FROM, true));
  return parent > 0 ? parent : null;
}

export function commandLineOf(api: ProcessReads, handle: number): string | null {
  if (!api.hasNt) return null;
  const basic = new Uint8Array(PROCESS_BASIC_INFORMATION_SIZE);
  if (!api.basicInfo(handle, basic)) return null;
  const peb = new DataView(basic.buffer).getBigUint64(OFF_PEB_BASE, true);
  if (peb === 0n) return null;

  const parameters = readPointer(api, handle, peb + BigInt(OFF_PROCESS_PARAMETERS));
  if (parameters === null || parameters === 0n) return null;

  const unicode = new Uint8Array(16);
  if (!api.readMemory(handle, parameters + BigInt(OFF_COMMAND_LINE), unicode)) return null;
  const view = new DataView(unicode.buffer);
  const length = view.getUint16(0, true);
  const address = view.getBigUint64(8, true);
  if (length === 0 || address === 0n || length > MAX_COMMAND_LINE_BYTES) return null;

  const text = new Uint8Array(length);
  if (!api.readMemory(handle, address, text)) return null;
  return Buffer.from(text.buffer, 0, length).toString('utf16le');
}

function readPointer(api: ProcessReads, handle: number, address: bigint): bigint | null {
  const buffer = new Uint8Array(8);
  if (!api.readMemory(handle, address, buffer)) return null;
  return new DataView(buffer.buffer).getBigUint64(0, true);
}

export function exitCodeOf(api: ProcessReads, handle: number): number | null {
  const code = new Uint32Array(1);
  if (!api.exitCode(handle, code)) return null;
  const value = code[0] ?? 0;
  return value === STILL_ACTIVE ? null : value | 0;
}

export function cpuMsOf(api: ProcessReads, handle: number): number | null {
  const times = new Uint8Array(32);
  if (!api.processTimes(handle, times)) return null;
  const view = new DataView(times.buffer);
  const total = view.getBigUint64(OFF_KERNEL_TIME, true) + view.getBigUint64(OFF_USER_TIME, true);
  return Math.round(Number(total) / 10_000);
}

/** Bytes the process read and wrote, files, pipes and devices alike. */
export function ioBytesOf(api: ProcessReads, handle: number): number | null {
  const counters = new Uint8Array(IO_COUNTERS_SIZE);
  if (!api.ioCounters(handle, counters)) return null;
  const view = new DataView(counters.buffer);
  const total = view.getBigUint64(OFF_READ_TRANSFER, true) + view.getBigUint64(OFF_WRITE_TRANSFER, true);
  return Number(total);
}

export function workingSetOf(api: ProcessReads, handle: number): { workingSet: number; peak: number } | null {
  const buffer = new Uint8Array(PROCESS_MEMORY_COUNTERS_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, PROCESS_MEMORY_COUNTERS_SIZE, true);
  if (!api.memoryInfo(handle, buffer)) return null;
  return {
    workingSet: Number(view.getBigUint64(OFF_WORKING_SET, true)),
    peak: Number(view.getBigUint64(OFF_PEAK_WORKING_SET, true)),
  };
}
