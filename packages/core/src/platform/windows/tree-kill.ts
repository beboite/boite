import { dlopen, FFIType } from 'bun:ffi';

/** Enough to keep the process object, and so its pid, alive: Windows grants it on nearly any process. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function loadKernel32() {
  return dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  });
}
let kernel32: ReturnType<typeof loadKernel32>['symbols'] | undefined;

/** A handle of our own on `pid`, released by the returned function, or null when it will not open. */
function holdPid(pid: number): (() => void) | null {
  kernel32 ??= loadKernel32().symbols;
  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === 0n) return null;
  return () => { kernel32!.CloseHandle(handle); };
}

function runTaskkill(pid: number): Promise<unknown> {
  // Not through procs.spawn: taskkill must not join the thread it stops.
  const taskkill = Bun.spawn({
    cmd: ['taskkill', '/T', '/F', '/PID', String(pid)],
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  });
  return taskkill.exited;
}

/**
 * Windows' fallback tree kill of a root the caller saw running in this tick.
 * The root is held by a handle of our own from this call until taskkill
 * ended: the spawner closes its handle when the root exits, and without ours
 * Windows could give the pid to another process before taskkill opens it.
 * No taskkill when the hold fails: the pid is then no longer surely the root's.
 */
export function treeKill(
  pid: number,
  hold: (pid: number) => (() => void) | null = holdPid,
  run: (pid: number) => Promise<unknown> = runTaskkill,
): Promise<unknown> | undefined {
  const release = hold(pid);
  if (release === null) return undefined;
  try {
    return run(pid).catch(() => undefined).finally(release);
  } catch {
    release();
    return undefined;
  }
}
