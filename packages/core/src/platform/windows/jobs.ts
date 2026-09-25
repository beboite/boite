/**
 * Windows Job Objects, reached with `bun:ffi`. Every process a thread launches
 * lands in that thread's job, direct child or not, so the trace sees a
 * grandchild that outlives its parent and `killTree` is one call instead of a
 * pid walk. Linux and macOS use the separate POSIX backend.
 *
 * One global job holds the machine-wide CPU cap; every thread job nests under
 * it, runs below normal priority and dies with the core (KILL_ON_JOB_CLOSE,
 * never BREAKAWAY_OK).
 */
import { cpus } from 'node:os';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { TraceCapability } from '@boite/contracts';
import type { JobsWorkerMessage, JobsWorkerStart } from './jobs-worker.ts';
import { workerEntry } from './worker-entry.ts';
import { commandLineOf, cpuMsOf, exitCodeOf, imageNameOf, ioBytesOf, parentPidOf, workingSetOf } from './process-reads.ts';

import type { NativeProcessInfo, NativeProcessExit, ProcessSample, ProcessEventSink, ProcessLimits } from '../types.ts';

// -- Win32 constants --------------------------------------------------------

const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
const JOB_OBJECT_LIMIT_PRIORITY_CLASS = 0x20;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
const CPU_RATE_CONTROL_ENABLE = 0x1;
const CPU_RATE_CONTROL_HARD_CAP = 0x4;

const CLASS_BASIC_PROCESS_ID_LIST = 3;
const CLASS_ASSOCIATE_COMPLETION_PORT = 7;
const CLASS_BASIC_AND_IO_ACCOUNTING = 8;
const CLASS_EXTENDED_LIMIT = 9;
const CLASS_CPU_RATE_CONTROL = 15;

const MSG_ACTIVE_PROCESS_ZERO = 4;
const MSG_NEW_PROCESS = 6;
const MSG_EXIT_PROCESS = 7;
const MSG_ABNORMAL_EXIT_PROCESS = 8;
const MSG_PROCESS_MEMORY_LIMIT = 9;
const MSG_JOB_MEMORY_LIMIT = 10;

const PROCESS_TERMINATE = 0x1;
const PROCESS_VM_READ = 0x10;
const PROCESS_SET_QUOTA = 0x100;
const PROCESS_QUERY_INFORMATION = 0x400;
const ERROR_ACCESS_DENIED = 5;
/** What OpenProcess says for a pid no process holds any more. */
const ERROR_INVALID_PARAMETER = 87;
const KILL_EXIT_CODE = 9;

// -- Struct offsets, all x64 ------------------------------------------------

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION. */
const EXTENDED_LIMIT_SIZE = 144;
/** JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags. */
const OFF_LIMIT_FLAGS = 16;
/** BasicLimitInformation.PriorityClass. Offset 60 is SchedulingClass and is ignored. */
const OFF_PRIORITY_CLASS = 56;
/** ExtendedLimitInformation.JobMemoryLimit, after the 64-byte basic part and IO_COUNTERS. */
const OFF_JOB_MEMORY_LIMIT = 120;
/** JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.TotalUserTime, in 100 ns units. */
const OFF_TOTAL_USER_TIME = 0;
/** ...TotalKernelTime. */
const OFF_TOTAL_KERNEL_TIME = 8;
/** ...ActiveProcesses. */
const OFF_ACTIVE_PROCESSES = 40;
/** The accounting struct plus its IO_COUNTERS tail. */
const ACCOUNTING_SIZE = 96;

const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const INFINITE = 0xffffffff;
const ASSIGN_ACCESS = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION;
const INSPECT_ACCESS = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE;

const EVENTS_NOTE =
  'every process a thread launches, direct or not, is in its Job Object; exact start and exit events';

/**
 * Windows puts a console host in the job as soon as a child's output is piped.
 * It is the OS attaching a console, not something the thread asked for, so it
 * stays out of the trace and out of the load.
 */
const CONSOLE_HOSTS = new Set(['conhost.exe', 'openconsole.exe']);

function loadKernel32() {
  return dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CreateIoCompletionPort: { args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.ptr },
    PostQueuedCompletionStatus: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    QueryFullProcessImageNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    GetProcessIoCounters: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ReadProcessMemory: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
}

function loadNtdll() {
  return dlopen('ntdll.dll', {
    NtQueryInformationProcess: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
}

type Kernel32 = ReturnType<typeof loadKernel32>['symbols'];
type Ntdll = ReturnType<typeof loadNtdll>['symbols'];

/** `bun:ffi` brands a pointer; handles travel as plain numbers everywhere else here. */
function asPointer(handle: number): Pointer {
  return handle as unknown as Pointer;
}

function asHandle(value: bigint | Pointer | null): number {
  return value === null ? 0 : Number(value);
}

/** The whole Win32 surface this module uses, with handles as numbers. */
function nativeApi(k32: Kernel32, nt: Ntdll | null) {
  return {
    hasNt: nt !== null,
    lastError: (): number => k32.GetLastError(),
    createJob: (): number => asHandle(k32.CreateJobObjectW(null, null)),
    setJobInfo: (job: number, klass: number, buffer: Uint8Array): boolean =>
      k32.SetInformationJobObject(asPointer(job), klass, ptr(buffer), buffer.byteLength) !== 0,
    queryJobInfo: (job: number, klass: number, buffer: Uint8Array): boolean =>
      k32.QueryInformationJobObject(asPointer(job), klass, ptr(buffer), buffer.byteLength, null) !== 0,
    assign: (job: number, proc: number): boolean =>
      k32.AssignProcessToJobObject(asPointer(job), asPointer(proc)) !== 0,
    terminateJob: (job: number, exitCode: number): boolean =>
      k32.TerminateJobObject(asPointer(job), exitCode) !== 0,
    terminateProcess: (proc: number, exitCode: number): boolean =>
      k32.TerminateProcess(asPointer(proc), exitCode) !== 0,
    createPort: (): number => asHandle(k32.CreateIoCompletionPort(INVALID_HANDLE_VALUE, null, 0n, 1)),
    /** Key 0 on the port: the drain's signal to stop. Thread job keys start at 1. */
    wakeToStop: (port: number): boolean => k32.PostQueuedCompletionStatus(asPointer(port), 0, 0n, null) !== 0,
    openProcess: (access: number, pid: number): number => asHandle(k32.OpenProcess(access, 0, pid)),
    close: (handle: number): void => {
      k32.CloseHandle(asPointer(handle));
    },
    imageName: (proc: number, buffer: Uint16Array, size: Uint32Array): boolean =>
      k32.QueryFullProcessImageNameW(asPointer(proc), 0, ptr(buffer), ptr(size)) !== 0,
    exitCode: (proc: number, out: Uint32Array): boolean =>
      k32.GetExitCodeProcess(asPointer(proc), ptr(out)) !== 0,
    processTimes: (proc: number, out: Uint8Array): boolean =>
      k32.GetProcessTimes(asPointer(proc), ptr(out, 0), ptr(out, 8), ptr(out, 16), ptr(out, 24)) !== 0,
    memoryInfo: (proc: number, out: Uint8Array): boolean =>
      k32.K32GetProcessMemoryInfo(asPointer(proc), ptr(out), out.byteLength) !== 0,
    ioCounters: (proc: number, out: Uint8Array): boolean =>
      k32.GetProcessIoCounters(asPointer(proc), ptr(out)) !== 0,
    readMemory: (proc: number, address: bigint, into: Uint8Array): boolean => {
      const read = new Uint8Array(8);
      return (
        k32.ReadProcessMemory(asPointer(proc), address, ptr(into), BigInt(into.byteLength), ptr(read)) !== 0
      );
    },
    basicInfo: (proc: number, out: Uint8Array): boolean => {
      if (nt === null) return false;
      const returned = new Uint32Array(1);
      return nt.NtQueryInformationProcess(asPointer(proc), 0, ptr(out), out.byteLength, ptr(returned)) === 0;
    },
  };
}

type Native = ReturnType<typeof nativeApi>;

interface TrackedProcess {
  threadId: string;
  handle: number;
  peakMemoryBytes: number;
}

interface ThreadJob {
  handle: number;
  key: number;
  pids: Set<number>;
  lastCpu100ns: bigint;
  lastSampleAt: number;
}

const LOGICAL_CPUS = Math.max(1, cpus().length);

let refCount = 0;
let native: Native | null = null;
let nativeError: string | null = null;
let globalJob = 0;
let completionPort = 0;
let worker: Worker | null = null;
let workerFailure: string | null = null;
let stopFlag: Int32Array | null = null;
/**
 * A Worker stopped because no job held a process any more, until its loop is
 * out. The port stays open meanwhile: what it queues waits for the next Worker,
 * which starts only once this one is gone, so two never drain the port at once.
 */
let retiring: Worker | null = null;
let restartWanted = false;
/** How long the Worker stays up once no job holds a process, so a burst of short processes keeps one. */
let idleGraceMs = 30_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let nestingRefused = false;
let sink: ProcessEventSink | null = null;
let limits: ProcessLimits = { agentCpuCapPercent: 75, threadMemoryCapMb: 0 };
let nextKey = 1;

const threadJobs = new Map<string, ThreadJob>();
const threadsByKey = new Map<number, string>();
const tracked = new Map<number, TrackedProcess>();
const ignored = new Set<number>();

// -- lifecycle --------------------------------------------------------------

export function retainJobs(events: ProcessEventSink): void {
  refCount += 1;
  sink = events;
}

/** Test seams: how long the Worker outlives the last process, and whether one runs. */
export function setJobsIdleGrace(ms: number): void {
  idleGraceMs = ms;
}

/**
 * A turn is starting: boot the drain now, while the turn prepares, rather than
 * when its first process joins a job. A Worker takes tens of milliseconds to
 * start, and a process that starts and ends inside that wait is gone before
 * anything can read what it was. The idle window runs from here, as it does
 * after the last exit, so a turn that never spawns does not keep it.
 */
export function warmJobs(): void {
  if (workerFailure !== null) return;
  const api = ensureNative();
  if (api === null) return;
  if (completionPort === 0) completionPort = api.createPort();
  if (completionPort === 0) return;
  ensureWorker(completionPort);
  if (worker !== null && jobsEmpty()) armIdle();
}

export function jobsWorkerRunning(): boolean {
  return worker !== null;
}

/** Resolves once the drain left its wait and the port is closed, one second at most. */
export function releaseJobs(): Promise<void> {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return Promise.resolve();
  sink = null;
  return teardown();
}

/**
 * Before the first process nothing native exists, so the limits are only
 * recorded here; `ensureThreadJob` applies them when it builds the job.
 */
export function setProcessLimits(next: ProcessLimits): void {
  limits = { ...next };
  const api = native;
  if (api === null) return;
  if (globalJob !== 0) applyCpuCap(api, globalJob);
  for (const job of threadJobs.values()) applyThreadLimits(api, job.handle);
}

/** The global job's CPU rate control as the kernel holds it. Read by the tests only. */
export function cpuRateOfGlobalJob(): { flags: number; rate: number } | null {
  const api = native;
  if (api === null || globalJob === 0) return null;
  const buffer = new Uint8Array(8);
  if (!api.queryJobInfo(globalJob, CLASS_CPU_RATE_CONTROL, buffer)) return null;
  const view = new DataView(buffer.buffer);
  return { flags: view.getUint32(0, true), rate: view.getUint32(4, true) };
}

export function jobsCapability(): TraceCapability {
  const os = 'windows' as const;
  if (native === null) {
    // Nothing has been spawned yet, so nothing was loaded: this says what the
    // Windows path will do, and a later failure moves it to `poll`.
    if (nativeError === null) return { os, mode: 'events', note: EVENTS_NOTE };
    return {
      os,
      mode: 'poll',
      note: `Job Objects unavailable (${nativeError}); direct children only`,
    };
  }
  const suffix = nestingRefused
    ? '; the global job refused nesting (access denied), thread jobs run standalone'
    : '';
  if (workerFailure !== null) {
    return {
      os,
      mode: 'poll',
      note: `every process is in its thread Job Object, but the completion port worker failed (${workerFailure}), so starts and exits are polled every 500 ms${suffix}`,
    };
  }
  return { os, mode: 'events', note: `${EVENTS_NOTE}${suffix}` };
}

// -- the two seams `procs` calls --------------------------------------------

export function assignToThreadJob(threadId: string, pid: number): boolean {
  if (pid <= 0) return false;
  const api = ensureNative();
  if (api === null) return false;

  const job = ensureThreadJob(api, threadId);
  if (job === null) return false;
  // A job built earlier kept its port; its Worker may have gone idle since.
  cancelIdle();
  if (completionPort !== 0) ensureWorker(completionPort);

  const handle = api.openProcess(ASSIGN_ACCESS, pid);
  if (handle === 0) return false;
  try {
    if (globalJob !== 0 && !nestingRefused) {
      // The thread job nests under the global job through this first assignment:
      // the process is already in the global job when it joins the thread job.
      if (!api.assign(globalJob, handle) && api.lastError() === ERROR_ACCESS_DENIED) nestingRefused = true;
    }
    return api.assign(job.handle, handle);
  } finally {
    api.close(handle);
  }
}

export function terminateThreadJob(threadId: string): boolean {
  const job = threadJobs.get(threadId);
  if (job === undefined) return false;
  const api = ensureNative();
  if (api === null) return false;
  return api.terminateJob(job.handle, KILL_EXIT_CODE);
}

/**
 * The handle opened when the job reported the process, never a fresh open by
 * pid: a pid the process gave back may already belong to something else.
 */
export function terminateJobProcess(threadId: string, pid: number): boolean {
  const entry = tracked.get(pid);
  if (entry === undefined || entry.threadId !== threadId) return false;
  const api = ensureNative();
  if (api === null) return false;
  return api.terminateProcess(entry.handle, KILL_EXIT_CODE);
}

/**
 * Close the job of a thread the registry forgot. A job that still holds a pid
 * is kept: closing it would kill that process through KILL_ON_JOB_CLOSE. Once
 * the key is gone a late packet for it is dropped, and the same thread id
 * spawning again gets a new job and a new key.
 */
export function releaseThreadJob(threadId: string): void {
  const job = threadJobs.get(threadId);
  if (job === undefined || job.pids.size > 0) return;
  threadJobs.delete(threadId);
  threadsByKey.delete(job.key);
  native?.close(job.handle);
}

/** How many thread jobs are open. Read by the tests only. */
export function threadJobCount(): number {
  return threadJobs.size;
}

/** CPU over the interval since the previous sample, memory as the live working sets. */
export function sampleThreadJob(threadId: string): ProcessSample | null {
  const job = threadJobs.get(threadId);
  if (job === undefined) return null;
  const api = ensureNative();
  if (api === null) return null;

  const buffer = new Uint8Array(ACCOUNTING_SIZE);
  if (!api.queryJobInfo(job.handle, CLASS_BASIC_AND_IO_ACCOUNTING, buffer)) return null;
  const view = new DataView(buffer.buffer);
  const total = view.getBigUint64(OFF_TOTAL_USER_TIME, true) + view.getBigUint64(OFF_TOTAL_KERNEL_TIME, true);
  const now = Date.now();
  const elapsedMs = now - job.lastSampleAt;
  let cpuPercent = 0;
  if (job.lastSampleAt > 0 && elapsedMs > 0 && total >= job.lastCpu100ns) {
    const cpuMs = Number(total - job.lastCpu100ns) / 10_000;
    cpuPercent = Math.round((cpuMs / (elapsedMs * LOGICAL_CPUS)) * 1000) / 10;
  }
  job.lastCpu100ns = total;
  job.lastSampleAt = now;

  let memoryBytes = 0;
  for (const [pid, entry] of tracked) {
    if (entry.threadId !== threadId) continue;
    const memory = workingSetOf(api, entry.handle);
    if (memory === null) continue;
    memoryBytes += memory.workingSet;
    if (memory.peak > entry.peakMemoryBytes) {
      tracked.set(pid, { ...entry, peakMemoryBytes: memory.peak });
    }
  }

  return { processes: view.getUint32(OFF_ACTIVE_PROCESSES, true), cpuPercent, memoryBytes };
}

// -- job creation -----------------------------------------------------------

function ensureNative(): Native | null {
  if (native !== null) return native;
  if (nativeError !== null) return null;
  try {
    const k32 = loadKernel32().symbols;
    let nt: Ntdll | null = null;
    try {
      nt = loadNtdll().symbols;
    } catch {
      // parentPid and commandLine stay null without ntdll; the rest still works.
      nt = null;
    }
    native = nativeApi(k32, nt);
    return native;
  } catch (error) {
    nativeError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function applyCpuCap(api: Native, job: number): void {
  const percent = limits.agentCpuCapPercent;
  const buffer = new Uint8Array(8);
  // 0 and 100 mean no cap. They are still written, as all zeros: a cap set
  // earlier stays on the job until something replaces it, and zeros on a job
  // that never had one succeed and change nothing.
  if (percent > 0 && percent < 100) {
    const view = new DataView(buffer.buffer);
    view.setUint32(0, CPU_RATE_CONTROL_ENABLE | CPU_RATE_CONTROL_HARD_CAP, true);
    // CpuRate is in hundredths of a percent of the whole machine.
    view.setUint32(4, Math.max(1, Math.round(percent * 100)), true);
  }
  api.setJobInfo(job, CLASS_CPU_RATE_CONTROL, buffer);
}

function applyThreadLimits(api: Native, job: number): void {
  const buffer = new Uint8Array(EXTENDED_LIMIT_SIZE);
  const view = new DataView(buffer.buffer);
  let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PRIORITY_CLASS;
  view.setUint32(OFF_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, true);
  if (limits.threadMemoryCapMb > 0) {
    flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
    view.setBigUint64(OFF_JOB_MEMORY_LIMIT, BigInt(Math.round(limits.threadMemoryCapMb)) * 1024n * 1024n, true);
  }
  view.setUint32(OFF_LIMIT_FLAGS, flags, true);
  api.setJobInfo(job, CLASS_EXTENDED_LIMIT, buffer);
}

function ensureGlobalJob(api: Native): void {
  if (globalJob !== 0) return;
  const handle = api.createJob();
  if (handle === 0) return;
  const buffer = new Uint8Array(EXTENDED_LIMIT_SIZE);
  new DataView(buffer.buffer).setUint32(OFF_LIMIT_FLAGS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  api.setJobInfo(handle, CLASS_EXTENDED_LIMIT, buffer);
  globalJob = handle;
  applyCpuCap(api, handle);
}

function ensureThreadJob(api: Native, threadId: string): ThreadJob | null {
  const existing = threadJobs.get(threadId);
  if (existing !== undefined) return existing;

  ensureGlobalJob(api);
  const handle = api.createJob();
  if (handle === 0) return null;
  applyThreadLimits(api, handle);

  const key = nextKey;
  nextKey += 1;
  if (completionPort === 0) completionPort = api.createPort();
  if (completionPort !== 0) {
    // Associate before the first process joins, or its NEW_PROCESS is never queued.
    const assoc = new Uint8Array(16);
    const view = new DataView(assoc.buffer);
    view.setBigUint64(0, BigInt(key), true);
    view.setBigUint64(8, BigInt(completionPort), true);
    api.setJobInfo(handle, CLASS_ASSOCIATE_COMPLETION_PORT, assoc);
    ensureWorker(completionPort);
  }

  const job: ThreadJob = { handle, key, pids: new Set(), lastCpu100ns: 0n, lastSampleAt: 0 };
  threadJobs.set(threadId, job);
  threadsByKey.set(key, threadId);
  return job;
}

// -- the completion port drain ----------------------------------------------

function ensureWorker(port: number): void {
  if (worker !== null || workerFailure !== null) return;
  if (retiring !== null) {
    restartWanted = true;
    return;
  }
  const shared = new SharedArrayBuffer(4);
  stopFlag = new Int32Array(shared);
  try {
    const created = new Worker(workerEntry(import.meta.url, 'jobs-worker'));
    created.onmessage = (event: { data: unknown }): void => {
      onWorkerMessage(event.data as JobsWorkerMessage);
    };
    created.onerror = (event: unknown): void => {
      failWorker(describeWorkerError(event));
    };
    // No timeout: the Worker sleeps in the kernel until a packet comes, and
    // teardown posts one of its own to wake it.
    const start: JobsWorkerStart = { port, stop: shared, waitMs: INFINITE, inspectAccess: INSPECT_ACCESS };
    created.postMessage(start);
    // Typed structurally: the bench type-checks this file under the DOM lib, whose Worker has no unref.
    (created as { unref?: () => void }).unref?.();
    worker = created;
  } catch (error) {
    failWorker(error instanceof Error ? error.message : String(error));
  }
}

function describeWorkerError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (typeof event === 'object' && event !== null && 'message' in event) {
    return String((event as { message: unknown }).message);
  }
  return 'worker error';
}

function failWorker(reason: string): void {
  if (workerFailure !== null) return;
  workerFailure = reason;
  worker = null;
  startPolling();
}

function cancelIdle(): void {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

/** True when no job holds a process: nothing can start in one again without `assignToThreadJob`. */
function jobsEmpty(): boolean {
  if (tracked.size > 0 || ignored.size > 0) return false;
  for (const job of threadJobs.values()) if (job.pids.size > 0) return false;
  return true;
}

function armIdle(): void {
  cancelIdle();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (jobsEmpty()) retireWorker();
  }, idleGraceMs);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

/**
 * Stops the drain once no job holds a process. The packets it takes on its way
 * out are still handled; a process assigned meanwhile gets its Worker once this
 * one has left, and finds its events queued on the port.
 */
function retireWorker(): void {
  const running = worker;
  const flag = stopFlag;
  if (running === null || retiring !== null) return;
  worker = null;
  stopFlag = null;
  retiring = running;
  running.onerror = null;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    running.terminate();
    if (retiring !== running) return;
    retiring = null;
    const again = restartWanted;
    restartWanted = false;
    if (again && refCount > 0 && completionPort !== 0) ensureWorker(completionPort);
  };
  running.onmessage = (event: { data: unknown }): void => {
    const message = event.data as JobsWorkerMessage;
    if (message.kind === 'stopped') finish();
    else if (message.kind === 'packet') onWorkerMessage(message);
  };
  if (flag !== null) Atomics.store(flag, 0, 1);
  // The wait has no timeout: this packet is what wakes it to read the flag.
  if (completionPort !== 0) native?.wakeToStop(completionPort);
  const timer = setTimeout(finish, 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function onWorkerMessage(message: JobsWorkerMessage): void {
  switch (message.kind) {
    case 'packet':
      onJobPacket(message.message, message.key, message.pid, message.handle);
      return;
    case 'failed':
      failWorker(message.reason);
      return;
    default:
      return;
  }
}

function onJobPacket(message: number, key: number, pid: number, handle = 0): void {
  const threadId = threadsByKey.get(key);
  if (threadId === undefined) {
    if (handle !== 0) native?.close(handle);
    return;
  }
  switch (message) {
    case MSG_NEW_PROCESS:
      onProcessStarted(threadId, pid, handle);
      return;
    case MSG_EXIT_PROCESS:
    case MSG_ABNORMAL_EXIT_PROCESS:
      onProcessExited(threadId, pid);
      return;
    case MSG_ACTIVE_PROCESS_ZERO:
      // TerminateJobObject sends no per-process exit, only this. Anything the
      // job still held is gone, so the last exits are reported from here.
      for (const gone of [...(threadJobs.get(threadId)?.pids ?? [])]) onProcessExited(threadId, gone);
      return;
    case MSG_PROCESS_MEMORY_LIMIT:
      sink?.note(threadId, `process ${pid} reached the memory limit`);
      return;
    case MSG_JOB_MEMORY_LIMIT:
      sink?.note(threadId, 'the thread reached its memory cap');
      return;
    default:
      return;
  }
}

/** Only used when the Worker cannot run: diff the job's pid list every 500 ms. */
function startPolling(): void {
  if (pollTimer !== null) return;
  const timer = setInterval(() => {
    const api = ensureNative();
    if (api === null) return;
    for (const [threadId, job] of threadJobs) {
      const seen = listJobPids(api, job.handle);
      if (seen === null) continue;
      for (const pid of seen) {
        if (!job.pids.has(pid)) onProcessStarted(threadId, pid);
      }
      for (const pid of [...job.pids]) {
        if (!seen.has(pid)) onProcessExited(threadId, pid);
      }
    }
  }, 500);
  if (typeof timer.unref === 'function') timer.unref();
  pollTimer = timer;
}

function listJobPids(api: Native, job: number): Set<number> | null {
  const capacity = 256;
  const buffer = new Uint8Array(8 + capacity * 8);
  if (!api.queryJobInfo(job, CLASS_BASIC_PROCESS_ID_LIST, buffer)) return null;
  const view = new DataView(buffer.buffer);
  const count = Math.min(view.getUint32(4, true), capacity);
  const pids = new Set<number>();
  for (let index = 0; index < count; index += 1) pids.add(Number(view.getBigUint64(8 + index * 8, true)));
  return pids;
}

// -- per process reads ------------------------------------------------------

/**
 * `opened` is the handle the Worker took the moment the packet came, 0 when it
 * had none. Opening it here instead waits for this thread's event loop, and a
 * process killed within that wait is gone: nothing then tells a console host
 * from a real child, and the trace gains a nameless process.
 */
function onProcessStarted(threadId: string, pid: number, opened = 0): void {
  const api = ensureNative();
  if (pid <= 0 || tracked.has(pid) || ignored.has(pid) || api === null) {
    if (opened !== 0) api?.close(opened);
    return;
  }
  cancelIdle();
  threadJobs.get(threadId)?.pids.add(pid);

  const handle = opened !== 0 ? opened : api.openProcess(INSPECT_ACCESS, pid);
  if (handle === 0) {
    // Gone before anything could open it, typically the console host of a
    // child killed within a millisecond of its start: there is no name, no
    // parent and no true start time to record. Its exit is swallowed the same
    // way as a console host's; its CPU stays in the job totals.
    if (api.lastError() === ERROR_INVALID_PARAMETER) {
      ignored.add(pid);
      return;
    }
    sink?.started(threadId, pid, { exe: 'unknown', commandLine: null, parentPid: null });
    return;
  }
  const exe = imageNameOf(api, handle) ?? 'unknown';
  if (CONSOLE_HOSTS.has(baseName(exe))) {
    ignored.add(pid);
    api.close(handle);
    return;
  }
  tracked.set(pid, { threadId, handle, peakMemoryBytes: 0 });
  sink?.started(threadId, pid, {
    exe,
    commandLine: commandLineOf(api, handle),
    parentPid: parentPidOf(api, handle),
  });
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return (cut === -1 ? path : path.slice(cut + 1)).toLowerCase();
}

function onProcessExited(threadId: string, pid: number): void {
  reportExit(threadId, pid);
  if (worker !== null && jobsEmpty()) armIdle();
}

function reportExit(threadId: string, pid: number): void {
  threadJobs.get(threadId)?.pids.delete(pid);
  if (ignored.delete(pid)) return;
  const entry = tracked.get(pid);
  const api = ensureNative();
  if (entry === undefined || api === null) {
    sink?.exited(threadId, pid, { exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
    return;
  }
  tracked.delete(pid);
  const exit: NativeProcessExit = {
    exitCode: exitCodeOf(api, entry.handle),
    cpuMs: cpuMsOf(api, entry.handle),
    peakMemoryBytes: peakMemoryOf(api, entry),
    ioBytes: ioBytesOf(api, entry.handle),
  };
  api.close(entry.handle);
  sink?.exited(threadId, pid, exit);
}

function peakMemoryOf(api: Native, entry: TrackedProcess): number | null {
  const memory = workingSetOf(api, entry.handle);
  const peak = Math.max(memory?.peak ?? 0, entry.peakMemoryBytes);
  return peak > 0 ? peak : null;
}


// -- teardown ---------------------------------------------------------------

function teardown(): Promise<void> {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const api = native;
  if (api !== null) {
    for (const entry of tracked.values()) api.close(entry.handle);
    // Closing a job handle kills what is still in it: KILL_ON_JOB_CLOSE.
    for (const job of threadJobs.values()) api.close(job.handle);
    if (globalJob !== 0) api.close(globalJob);
  }
  tracked.clear();
  ignored.clear();
  threadJobs.clear();
  threadsByKey.clear();
  globalJob = 0;
  nestingRefused = false;
  workerFailure = null;

  // The port and the worker are released together and only once the loop is
  // out. Both are dropped from the module state now, so a core created before
  // that happens builds its own and never inherits a handle about to close.
  // A retiring Worker may still wait on the port: it is released the same way.
  cancelIdle();
  const port = completionPort;
  const running = worker ?? retiring;
  const flag = stopFlag;
  completionPort = 0;
  worker = null;
  stopFlag = null;
  retiring = null;
  restartWanted = false;

  const release = (): void => {
    if (api !== null && port !== 0) api.close(port);
    running?.terminate();
  };
  if (running === null) {
    release();
    return Promise.resolve();
  }
  if (flag !== null) Atomics.store(flag, 0, 1);
  // The wait has no timeout: this packet is what wakes it to read the flag.
  if (api !== null && port !== 0) api.wakeToStop(port);
  return new Promise<void>((resolve) => {
    let released = false;
    const once = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      release();
      resolve();
    };
    // The loop leaves on that packet and posts 'stopped'; the port closes then,
    // never while the worker may still be blocked on it. Closing it on the
    // fallback also ends a wait nothing woke.
    running.onmessage = (event: { data: unknown }): void => {
      if ((event.data as JobsWorkerMessage).kind === 'stopped') once();
    };
    const timer = setTimeout(once, 1000);
  });
}
