/**
 * What the core reads from one process handle: name, parent, command line, exit
 * code, CPU time, memory and I/O, and whether those name a console host. Plain
 * reads over whatever Win32 surface is passed in, so the job lifecycle in
 * jobs.ts keeps only its own state.
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

interface ProcessAccess extends ProcessReads {
  openProcess(access: number, pid: number): number;
  close(handle: number): void;
}

/** Enough for GetProcessTimes, including processes that refuse the full query right. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

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
const OFF_PAGEFILE_USAGE = 56;
/** IO_COUNTERS: six u64, the three operation counts then the three transfer counts. */
const IO_COUNTERS_SIZE = 48;
const OFF_READ_TRANSFER = 24;
const OFF_WRITE_TRANSFER = 32;
/** GetProcessTimes writes four FILETIMEs; creation is the first, kernel the third, user the fourth. */
const OFF_CREATION_TIME = 0;
const OFF_KERNEL_TIME = 16;
const OFF_USER_TIME = 24;
/** 1970-01-01 as a FILETIME, in the 100 ns intervals since 1601 it counts. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
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
  // Its length can read before its text is written: zeros are a line not there yet.
  if (text.every(byte => byte === 0)) return null;
  return Buffer.from(text.buffer, 0, length).toString('utf16le');
}

/**
 * Gives `done` the command line once it reads, `first` being the read already
 * made. A job reports a new process before Windows has written its parameters:
 * on windows-2025 a ping's name and parent read while its command line was
 * still empty. The line is read again every `retryMs`, `tries` times at most,
 * then `done` gets null. Null when `done` ran already; otherwise `flush`
 * settles at once with what reads now, for a process that exits first, and
 * `cancel` drops it.
 */
export function whenCommandLineReads(api: ProcessReads, handle: number, first: string | null, done: (line: string | null) => void, tries = 20, retryMs = 5): { flush(): void; cancel(): void } | null {
  if (first !== null || !api.hasNt) { done(first); return null; }
  let settled = false;
  let attempt = 0;
  const settle = (line: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(line);
  };
  const poll = () => {
    const line = commandLineOf(api, handle);
    if (line !== null || ++attempt >= tries) settle(line);
    else timer = setTimeout(poll, retryMs);
  };
  let timer = setTimeout(poll, retryMs);
  return {
    flush: () => settle(commandLineOf(api, handle)),
    cancel: () => { settled = true; clearTimeout(timer); },
  };
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

/** Raw held-handle status for diagnostics: 259 is distinct from an API failure. */
export function exitStatusOf(api: Pick<ProcessReads, 'exitCode'> & {lastError(): number}, handle: number): {read: boolean; code: number | null; error: number} {
  const code = new Uint32Array(1);
  const read = api.exitCode(handle, code);
  const error = read ? 0 : api.lastError();
  return {read, code: read ? code[0] ?? 0 : null, error};
}

export function cpuMsOf(api: ProcessReads, handle: number): number | null {
  const times = new Uint8Array(32);
  if (!api.processTimes(handle, times)) return null;
  const view = new DataView(times.buffer);
  const total = view.getBigUint64(OFF_KERNEL_TIME, true) + view.getBigUint64(OFF_USER_TIME, true);
  return Math.round(Number(total) / 10_000);
}

export function peakMemoryOf(api: ProcessReads, entry: {handle: number; peakMemoryBytes: number}): number | null {
  const memory = workingSetOf(api, entry.handle);
  const peak = Math.max(memory?.peak ?? 0, entry.peakMemoryBytes);
  return peak > 0 ? peak : null;
}

/** Open the current PID owner for this read and always release its handle. */
export function createdAtOfPid(readApi: () => ProcessAccess | null, pid: number, runningOnly: boolean): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const api = readApi();
  if (api === null) return null;
  const handle = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, pid);
  if (handle === 0) return null;
  try {
    if (runningOnly && exitCodeOf(api, handle) !== null) return null;
    return createdAtOf(api, handle);
  } finally {
    api.close(handle);
  }
}

/** When the process was created, in ms since the Unix epoch. */
export function createdAtOf(api: ProcessReads, handle: number): number | null {
  return creationIdentityOf(api, handle)?.startedAt ?? null;
}

/** Capture both the trace timestamp and the exact identity from the same held handle. */
export function creationIdentityOf(api: ProcessReads, handle: number): { startedAt: number; incarnation: string } | null {
  const times = new Uint8Array(32);
  if (!api.processTimes(handle, times)) return null;
  const created = new DataView(times.buffer).getBigUint64(OFF_CREATION_TIME, true);
  if (created <= FILETIME_UNIX_EPOCH) return null;
  return { startedAt: Number((created - FILETIME_UNIX_EPOCH) / 10_000n), incarnation: created.toString() };
}

/** Bytes the process read and wrote, files, pipes and devices alike. */
export function ioBytesOf(api: ProcessReads, handle: number): number | null {
  const counters = new Uint8Array(IO_COUNTERS_SIZE);
  if (!api.ioCounters(handle, counters)) return null;
  const view = new DataView(counters.buffer);
  const total = view.getBigUint64(OFF_READ_TRANSFER, true) + view.getBigUint64(OFF_WRITE_TRANSFER, true);
  return Number(total);
}

export function workingSetOf(api: ProcessReads, handle: number): { workingSet: number; peak: number; committedBytes: number } | null {
  const buffer = new Uint8Array(PROCESS_MEMORY_COUNTERS_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, PROCESS_MEMORY_COUNTERS_SIZE, true);
  if (!api.memoryInfo(handle, buffer)) return null;
  return {
    committedBytes: Number(view.getBigUint64(OFF_PAGEFILE_USAGE, true)),
    workingSet: Number(view.getBigUint64(OFF_WORKING_SET, true)),
    peak: Number(view.getBigUint64(OFF_PEAK_WORKING_SET, true)),
  };
}

/**
 * Windows puts a console host in the job as soon as a child's output is piped.
 * It is the OS attaching a console, not something the thread asked for, so it
 * stays out of the trace and out of the load.
 */
const CONSOLE_HOSTS = new Set(['conhost.exe', 'openconsole.exe']);

/**
 * Whether a process is a console host, by its image name or, when that read
 * fails, by a command line that starts the system's own `conhost.exe`: a host
 * caught as it starts can refuse QueryFullProcessImageNameW and still show
 * `\??\C:\Windows\system32\conhost.exe 0x4` (Windows CI, 2026-10-18), and it
 * then entered the trace as `unknown`. Only that full path counts: an unquoted
 * `C:\Tools\conhost.exe helpers\worker.exe` is a real process.
 */
export function consoleHost(exe: string | null, commandLine: string | null): boolean {
  if (exe !== null) return CONSOLE_HOSTS.has(baseName(exe));
  if (commandLine === null) return false;
  // The program is the quoted path whole, else the text up to the first blank, which is what Windows itself runs.
  const program = /^\s*(?:"([^"]*)"|(\S+))/.exec(commandLine);
  const path = (program?.[1] ?? program?.[2] ?? '').toLowerCase().replace(/^\\\?\?\\|^\\\\\?\\/, '');
  return path === `${(process.env.SystemRoot ?? 'C:\\Windows').toLowerCase()}\\system32\\conhost.exe`;
}

/**
 * The name a started process enters the trace under once its command line
 * settled, or null for a console host. One caught as it starts can refuse
 * both its image name and its command line: a child of `bun -e` that ran
 * 38 ms in 7.5 MB entered prepared-drivers.test.ts's trace as `unknown`, with
 * no command line (Windows CI, 2026-10-19). After the wait, the name is read
 * once more.
 */
export function startedAs(api: ProcessReads, handle: number, exe: string | null, commandLine: string | null): string | null {
  const name = exe ?? imageNameOf(api, handle);
  return consoleHost(name, commandLine) ? null : name ?? 'unknown';
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return (cut === -1 ? path : path.slice(cut + 1)).toLowerCase();
}
