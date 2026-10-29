/**
 * A process and every descendant on Windows, read in this process: a Toolhelp
 * snapshot gives each pid, parent and image name, and
 * `NtQueryInformationProcess(ProcessCommandLineInformation)` each command line
 * (WebView2's `--type`). No PowerShell and no WMI: on a loaded runner
 * `Get-CimInstance Win32_Process` gave no answer within 10 s (job 118322361920),
 * and this takes milliseconds.
 */

export interface TreeProcess { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_COMMAND_LINE_INFORMATION = 60;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
/** PROCESSENTRY32W on x64: its fields, then `szExeFile` (260 UTF-16 units) at 44, padded to 8. */
const ENTRY_SIZE = 568;
const OFF_PID = 8;
const OFF_PARENT = 32;
const OFF_EXE = 44;
const EXE_CHARS = 260;

export async function windowsProcessTree(rootPid: number, authorized?: () => boolean): Promise<TreeProcess[]> {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  // Loading FFI can outlive the attempt that authorized this observation.
  if (authorized !== undefined && !authorized()) {
    throw Object.assign(new Error('process tree observation cancelled'), { code: 'ABORT_ERR' });
  }
  // HANDLEs are integers here, not FFI pointers: INVALID_HANDLE_VALUE is all ones.
  const k32 = dlopen('kernel32.dll', {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
    Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const nt = dlopen('ntdll.dll', {
    NtQueryInformationProcess: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
  });
  try {
    const all: TreeProcess[] = [];
    const snapshot = BigInt(k32.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (snapshot === 0xffffffffffffffffn) throw new Error(`CreateToolhelp32Snapshot failed: Windows error ${k32.symbols.GetLastError()}`);
    try {
      const entry = new Uint8Array(ENTRY_SIZE);
      const view = new DataView(entry.buffer);
      view.setUint32(0, ENTRY_SIZE, true);
      for (let more = k32.symbols.Process32FirstW(snapshot, ptr(entry)); more !== 0; more = k32.symbols.Process32NextW(snapshot, ptr(entry))) {
        const name = Buffer.from(entry.buffer, OFF_EXE, EXE_CHARS * 2).toString('utf16le');
        all.push({ ProcessId: view.getUint32(OFF_PID, true), ParentProcessId: view.getUint32(OFF_PARENT, true), Name: name.slice(0, Math.max(0, name.indexOf('\0'))), CommandLine: null });
      }
    } finally {
      k32.symbols.CloseHandle(snapshot);
    }
    const ids = new Set([rootPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const process of all) {
        if (!ids.has(process.ProcessId) && ids.has(process.ParentProcessId) && process.ProcessId !== 0) { ids.add(process.ProcessId); grew = true; }
      }
    }
    const tree = all.filter(process => ids.has(process.ProcessId));
    for (const process of tree) process.CommandLine = commandLine(process.ProcessId);
    return tree;
  } finally {
    k32.close();
    nt.close();
  }

  /** The command line, or null for a process that exited or refuses even a limited query. */
  function commandLine(pid: number): string | null {
    const handle = BigInt(k32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
    if (handle === 0n) return null;
    try {
      const returned = new Uint32Array(1);
      let buffer = new Uint8Array(4096);
      let status = nt.symbols.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, ptr(buffer), buffer.byteLength, ptr(returned));
      if (status === STATUS_INFO_LENGTH_MISMATCH && (returned[0] ?? 0) > buffer.byteLength) {
        buffer = new Uint8Array(returned[0]!);
        status = nt.symbols.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, ptr(buffer), buffer.byteLength, ptr(returned));
      }
      if (status !== 0) return null;
      // A UNICODE_STRING whose Buffer points at the text, inside this same buffer.
      const view = new DataView(buffer.buffer);
      const length = view.getUint16(0, true);
      const offset = Number(view.getBigUint64(8, true) - BigInt(ptr(buffer)));
      if (length === 0 || offset < 16 || offset + length > buffer.byteLength) return null;
      return Buffer.from(buffer.buffer, offset, length).toString('utf16le');
    } finally {
      k32.symbols.CloseHandle(handle);
    }
  }
}
