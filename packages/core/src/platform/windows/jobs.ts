/**
 * Windows Job Objects, reached with `bun:ffi`. Every process a thread launches
 * lands in that thread's job, direct child or not, so the trace sees a
 * grandchild that outlives its parent and `killTree` is one call instead of a
 * pid walk. Linux and macOS use the separate POSIX backend.
 *
 * The global job holds the CPU and memory caps. Thread jobs normally run below
 * normal priority, with normal priority during bounded agent initialization.
 */
import { cpus, totalmem } from 'node:os';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { TraceCapability } from '@boite/contracts';
import type { JobsWorkerMessage, JobsWorkerStart } from './jobs-worker.ts';
import { describeWorkerError, workerEntry } from './worker-entry.ts';
import { resolveMemoryLimits } from '../../memory-limits.ts';
import { StartupPriority } from './startup-priority.ts';
import { processEventDiagnostic } from '../../process-event-diagnostics.ts';
import { listJobPids } from './jobs-packets.ts';
import { applyCpuCap, applyMemoryLimit, cpuRateOfJob, memoryLimitOfJob as readMemoryLimit } from './job-limits.ts';
import {
  commandLineOf,
  consoleHost,
  cpuMsOf,
  createdAtOfPid,
  creationIdentityOf,
  exitCodeOf,
  exitStatusOf,
  imageNameOf,
  ioBytesOf,
  parentPidOf,
  peakMemoryOf,
  startedAs,
  whenCommandLineReads,
  workingSetOf,
} from './process-reads.ts';

import type { NativeProcessInfo, NativeProcessExit, ProcessSample, ProcessEventSink, ProcessLimits } from '../types.ts';

// -- Win32 constants --------------------------------------------------------

const BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
const NORMAL_PRIORITY_CLASS = 0x20;

const CLASS_ASSOCIATE_COMPLETION_PORT = 7;
const CLASS_BASIC_AND_IO_ACCOUNTING = 8;

const MSG_ACTIVE_PROCESS_ZERO = 4;
const MSG_NEW_PROCESS = 6;
const MSG_EXIT_PROCESS = 7;
const MSG_ABNORMAL_EXIT_PROCESS = 8;
const MSG_PROCESS_MEMORY_LIMIT = 9;
const MSG_JOB_MEMORY_LIMIT = 10;
/** Key 0 wakes the drain; key 1 belongs to the global job, never a thread. */
const GLOBAL_JOB_KEY = 1;

const PROCESS_TERMINATE = 0x1;
const PROCESS_VM_READ = 0x10;
const PROCESS_SET_QUOTA = 0x100;
const PROCESS_QUERY_INFORMATION = 0x400;
/** What OpenProcess says for a pid no process holds any more. */
const ERROR_INVALID_PARAMETER = 87;
const STILL_ACTIVE = 259;
const KILL_EXIT_CODE = 9;

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
    /** Key 0 on the port: the drain's signal to stop. Thread job keys start at 2. */
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
  identity: { startedAt: number; incarnation: string } | null;
}

interface ThreadJob {
  handle: number;
  startup: StartupPriority;
  key: number;
  pids: Set<number>;
  lastCpu100ns: bigint;
  lastSampleAt: number;
  /** The registry forgot the thread while the job still held a pid: release it when that pid leaves. */
  forgotten: boolean;
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
let limits: ProcessLimits = {
  agentCpuCapPercent: 75,
  ...resolveMemoryLimits({ agentMemoryBudgetPercent: 60, threadMemoryCapMb: 0, memoryReserveMb: 0 }, totalmem()),
};
let nextKey = GLOBAL_JOB_KEY + 1;

const threadJobs = new Map<string, ThreadJob>();
const threadsByKey = new Map<number, string>();
const tracked = new Map<number, TrackedProcess>();
const ignored = new Set<number>();
/** Processes whose `started` waits for their command line (`whenCommandLineReads`). */
const awaitingCommandLine = new Map<number, { flush(): void; cancel(): void }>();

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
  let capped = false;
  if (globalJob !== 0) {
    applyMemoryLimit(api, globalJob, Math.min(limits.budgetMb * 1.1, totalmem() / 1048576 * 0.9));
    const written = applyCpuCap(api, globalJob, limits.agentCpuCapPercent);
    capped = written && limits.agentCpuCapPercent > 0 && limits.agentCpuCapPercent < 100;
  }
  for (const job of threadJobs.values()) {
    if (capped) job.startup.apply();
    else job.startup.set(false);
  }
}

/** The global job's CPU rate control as the kernel holds it. Read by the tests only. */
export function cpuRateOfGlobalJob(): { flags: number; rate: number } | null {
  return native === null || globalJob === 0 ? null : cpuRateOfJob(native, globalJob);
}

/** The kernel's memory limit and flags. Null selects the global job; read by tests only. */
export function memoryLimitOfJob(threadId: string | null): { flags: number; bytes: number; priority: number } | null {
  const handle = threadId === null ? globalJob : threadJobs.get(threadId)?.handle;
  return native === null || !handle ? null : readMemoryLimit(native, handle);
}

/** Publication must observe native membership before delayed completion-port callbacks. */
export function threadJobHasProcesses(threadId: string): boolean {
  const job = threadJobs.get(threadId);
  if (job === undefined) return false;
  const api = ensureNative();
  const members = api === null ? null : listJobPids(api, job.handle);
  processEventDiagnostic('jobs.publication-membership', {threadId, members: members?.size ?? null});
  if (members === null || members.size > 0) return true;
  for (const pid of [...job.pids]) onProcessExited(threadId, pid);
  return false;
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
    ? '; the global job refused nesting, thread jobs run standalone'
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
      if (!api.assign(globalJob, handle)) nestingRefused = true;
    }
    if (nestingRefused || globalJob === 0) job.startup.set(false);
    return api.assign(job.handle, handle);
  } finally {
    api.close(handle);
  }
}

export function setThreadStartup(threadId: string, active: boolean): void {
  const api = ensureNative();
  const job = active && api ? ensureThreadJob(api, threadId) : threadJobs.get(threadId);
  if (!api || !job) return;
  const capped = active && !nestingRefused && globalJob !== 0 && applyCpuCap(api, globalJob, limits.agentCpuCapPercent);
  const configured = limits.agentCpuCapPercent > 0 && limits.agentCpuCapPercent < 100;
  job.startup.set(active && configured && capped);
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
 * stays until that pid leaves: closing it would kill the process through
 * KILL_ON_JOB_CLOSE. The registry never traces a console host, which exits after
 * its `cmd`; refusing outright left such a job open for the life of the core.
 * Once the key is gone a late packet for it is dropped, and the thread id
 * spawning again gets a new job and a new key.
 */
export function releaseThreadJob(threadId: string): void {
  const job = threadJobs.get(threadId);
  if (job === undefined) return;
  if (job.pids.size > 0) { job.forgotten = true; return; }
  threadJobs.delete(threadId);
  threadsByKey.delete(job.key);
  job.startup.close();
  native?.close(job.handle);
}

/**
 * When the process that holds `pid` now was created, in ms since the epoch, or
 * null when no process holds it or Windows will not open it. A fresh open by pid
 * on purpose: the question is who wears the pid today.
 */
export function processStartedAt(pid: number): number | null {
  return createdAtOfPid(ensureNative, pid, false);
}

/**
 * The same, for a process that has not exited. A pid still opens after its
 * process ended for as long as anything holds a handle on it, a parent that
 * spawned it for one, so the open alone does not say it runs.
 */
export function processRunningSince(pid: number): number | null {
  return createdAtOfPid(ensureNative, pid, true);
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
  const cpuMeasured = job.lastSampleAt > 0 && elapsedMs > 0 && total >= job.lastCpu100ns;
  let cpuPercent = 0;
  if (job.lastSampleAt > 0 && elapsedMs > 0 && total >= job.lastCpu100ns) {
    const cpuMs = Number(total - job.lastCpu100ns) / 10_000;
    cpuPercent = Math.round((cpuMs / (elapsedMs * LOGICAL_CPUS)) * 1000) / 10;
  }
  job.lastCpu100ns = total;
  job.lastSampleAt = now;

  let memoryBytes = 0;
  const workingSets: { pid: number; bytes: number; committedBytes: number }[] = [];
  for (const pid of job.pids) {
    const entry = tracked.get(pid);
    if (entry === undefined || entry.threadId !== threadId) continue;
    if (process.env.BOITE_DIAGNOSE_JOB_EVENTS === '1') processEventDiagnostic('jobs.sample-held', {threadId, pid,
      startedAt: entry.identity?.startedAt ?? null, incarnation: entry.identity?.incarnation ?? null,
      ...exitStatusOf(api, entry.handle), activeProcesses: view.getUint32(OFF_ACTIVE_PROCESSES, true)});
    const memory = workingSetOf(api, entry.handle);
    if (memory === null) continue;
    memoryBytes += memory.workingSet;
    workingSets.push({ pid, bytes: memory.workingSet, committedBytes: memory.committedBytes });
    if (memory.peak > entry.peakMemoryBytes) tracked.set(pid, { ...entry, peakMemoryBytes: memory.peak });
  }

  return { processes: view.getUint32(OFF_ACTIVE_PROCESSES, true), cpuPercent, memoryBytes, workingSets,
    cpuMeasured, memoryMeasured: workingSets.length > 0 };
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

function associatePort(api: Native, handle: number, key: number): void {
  if (completionPort === 0) completionPort = api.createPort();
  if (completionPort === 0) return;
  // Associate before the first process joins, or its NEW_PROCESS is never queued.
  const assoc = new Uint8Array(16);
  const view = new DataView(assoc.buffer);
  view.setBigUint64(0, BigInt(key), true);
  view.setBigUint64(8, BigInt(completionPort), true);
  api.setJobInfo(handle, CLASS_ASSOCIATE_COMPLETION_PORT, assoc);
  ensureWorker(completionPort);
}

function ensureGlobalJob(api: Native): void {
  if (globalJob !== 0) return;
  const handle = api.createJob();
  if (handle === 0) return;
  applyMemoryLimit(api, handle, Math.min(limits.budgetMb * 1.1, totalmem() / 1048576 * 0.9));
  globalJob = handle;
  applyCpuCap(api, handle, limits.agentCpuCapPercent);
  associatePort(api, handle, GLOBAL_JOB_KEY);
}

function ensureThreadJob(api: Native, threadId: string): ThreadJob | null {
  const existing = threadJobs.get(threadId);
  // A thread back before its forgotten job emptied keeps that job.
  if (existing !== undefined) { existing.forgotten = false; return existing; }

  ensureGlobalJob(api);
  const handle = api.createJob();
  if (handle === 0) return null;
  const key = nextKey;
  nextKey += 1;
  associatePort(api, handle, key);

  const startup = new StartupPriority((active) => applyMemoryLimit(api, handle, limits.threadMemoryCapMb * 1.1, active ? NORMAL_PRIORITY_CLASS : BELOW_NORMAL_PRIORITY_CLASS));
  const job: ThreadJob = { handle, startup, key, pids: new Set(), lastCpu100ns: 0n, lastSampleAt: 0, forgotten: false };
  startup.apply();
  threadJobs.set(threadId, job);
  threadsByKey.set(key, threadId);
  return job;
}

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
    const start: JobsWorkerStart = { port, stop: shared, waitMs: INFINITE, inspectAccess: INSPECT_ACCESS, globalKey: GLOBAL_JOB_KEY, workerId: crypto.randomUUID() };
    created.postMessage(start);
    // Typed structurally: the bench type-checks this file under the DOM lib, whose Worker has no unref.
    (created as { unref?: () => void }).unref?.();
    worker = created;
  } catch (error) {
    failWorker(error instanceof Error ? error.message : String(error));
  }
}


function failWorker(reason: string): void {
  if (workerFailure !== null) return;
  workerFailure = reason;
  worker = null;
  startPolling();
  processEventDiagnostic('main.polling-started', {workerFailed: true, armed: pollTimer !== null});
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
  const finish = (force: boolean): void => {
    // Core teardown may have taken ownership of this same stopping Worker.
    if (done || retiring !== running) return;
    done = true;
    clearTimeout(timer);
    running.onmessage = null;
    if (force) running.terminate();
    retiring = null;
    const again = restartWanted;
    restartWanted = false;
    if (again && refCount > 0 && completionPort !== 0) ensureWorker(completionPort);
  };
  running.addEventListener('close', () => finish(false), { once: true });
  running.onmessage = (event: { data: unknown }): void => {
    const message = event.data as JobsWorkerMessage;
    if (message.kind === 'stopped') running.onmessage = null;
    else if (message.kind === 'packet') onWorkerMessage(message);
  };
  if (flag !== null) Atomics.store(flag, 0, 1);
  // The wait has no timeout: this packet is what wakes it to read the flag.
  if (completionPort !== 0) native?.wakeToStop(completionPort);
  const timer = setTimeout(() => finish(true), 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function onWorkerMessage(message: JobsWorkerMessage): void {
  switch (message.kind) {
    case 'packet':
      processEventDiagnostic('main.packet', {workerId: message.workerId ?? null, sequence: message.sequence ?? null, message: message.message,
        key: message.key, pid: message.pid, captured: message.handle !== 0, threadId: threadsByKey.get(message.key) ?? null});
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
  if (key === GLOBAL_JOB_KEY) {
    // The Worker posts only the global budget alert; this stays for any other.
    if (handle !== 0) native?.close(handle);
    if (message === MSG_JOB_MEMORY_LIMIT) sink?.memoryLimit(tracked.get(pid)?.threadId ?? null, 'budget');
    return;
  }
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
      sink?.memoryLimit(threadId, 'thread-cap');
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

/**
 * `opened` is the handle the Worker took the moment the packet came, 0 when it
 * had none. Opening it here instead waits for this thread's event loop, and a
 * process killed within that wait is gone: nothing then tells a console host
 * from a real child, and the trace gains a nameless process.
 */
function onProcessStarted(threadId: string, pid: number, opened = 0): void {
  const api = ensureNative();
  if (pid <= 0 || tracked.has(pid) || api === null) {
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
    const error = api.lastError();
    processEventDiagnostic('jobs.start-unopened', {threadId, pid, error});
    if (error === ERROR_INVALID_PARAMETER) {
      ignored.add(pid);
      return;
    }
    sink?.started(threadId, pid, { exe: 'unknown', commandLine: null, parentPid: null });
    return;
  }
  // A new start can reuse an ignored PID whose exit packet never arrived.
  // Classify its captured handle again; the earlier process owned no handle here.
  ignored.delete(pid);
  const exe = imageNameOf(api, handle);
  const commandLine = commandLineOf(api, handle);
  // A console host stays out of the trace, and so does its exit.
  const ignore = (): void => {
    processEventDiagnostic('jobs.start-console', {threadId, pid});
    tracked.delete(pid); ignored.add(pid); api.close(handle);
  };
  if (consoleHost(exe, commandLine)) return ignore();
  const identity = creationIdentityOf(api, handle);
  processEventDiagnostic('jobs.start-captured', {threadId, pid, startedAt: identity?.startedAt ?? null,
    incarnation: identity?.incarnation ?? null, awaitingCommandLine: commandLine === null && api.hasNt});
  tracked.set(pid, { threadId, handle, peakMemoryBytes: 0, identity });
  const record = { parentPid: parentPidOf(api, handle), ...identity };
  const waiting = whenCommandLineReads(api, handle, commandLine, (line) => {
    awaitingCommandLine.delete(pid);
    const name = startedAs(api, handle, exe, line);
    if (name === null) return ignore();
    processEventDiagnostic('jobs.start-emitted', {threadId, pid, startedAt: identity?.startedAt ?? null,
      incarnation: identity?.incarnation ?? null});
    sink?.started(threadId, pid, { ...record, exe: name, commandLine: line });
  });
  if (waiting !== null) awaitingCommandLine.set(pid, waiting);
}

function onProcessExited(threadId: string, pid: number): void {
  reportExit(threadId, pid);
  const job = threadJobs.get(threadId);
  if (job?.forgotten === true && job.pids.size === 0) releaseThreadJob(threadId);
  if (worker !== null && jobsEmpty()) armIdle();
}

function reportExit(threadId: string, pid: number): void {
  const entry = tracked.get(pid);
  processEventDiagnostic('jobs.exit-received', {threadId, pid, owner: entry?.threadId ?? null, ignored: ignored.has(pid)});
  if (entry !== undefined && entry.threadId !== threadId) return;
  const api = ensureNative();
  if (entry !== undefined && api !== null) {
    const code = new Uint32Array(1);
    // A late pid-only exit/empty-job packet cannot retire a replacement whose
    // captured handle proves it is still running. Failed reads retain the
    // notification path, with the already captured creation identity.
    const read = api.exitCode(entry.handle, code);
    processEventDiagnostic('jobs.exit-read', {threadId, pid, read, code: read ? code[0]! : null,
      error: read ? 0 : api.lastError(), startedAt: entry.identity?.startedAt ?? null, incarnation: entry.identity?.incarnation ?? null});
    if (read && code[0] === STILL_ACTIVE) return;
  }
  threadJobs.get(threadId)?.pids.delete(pid);
  if (ignored.delete(pid)) return;
  if (entry === undefined || api === null) {
    processEventDiagnostic('jobs.exit-pid-only', {threadId, pid});
    sink?.exited(threadId, pid, { exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
    return;
  }
  // Its start goes out first, with whatever command line it has by now, unless that shows a console host.
  awaitingCommandLine.get(pid)?.flush();
  if (ignored.delete(pid)) return;
  tracked.delete(pid);
  const exit: NativeProcessExit = {
    ...entry.identity,
    exitCode: exitCodeOf(api, entry.handle),
    cpuMs: cpuMsOf(api, entry.handle),
    peakMemoryBytes: peakMemoryOf(api, entry),
    ioBytes: ioBytesOf(api, entry.handle),
  };
  api.close(entry.handle);
  processEventDiagnostic('jobs.exit-emitted', {threadId, pid, startedAt: exit.startedAt ?? null,
    incarnation: exit.incarnation ?? null, code: exit.exitCode});
  sink?.exited(threadId, pid, exit);
}

// -- teardown ---------------------------------------------------------------

function teardown(): Promise<void> {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const waiting of awaitingCommandLine.values()) waiting.cancel();
  awaitingCommandLine.clear();
  const api = native;
  if (api !== null) {
    for (const entry of tracked.values()) api.close(entry.handle);
    // Closing a job handle kills what is still in it: KILL_ON_JOB_CLOSE.
    for (const job of threadJobs.values()) {
      job.startup.close();
      api.close(job.handle);
    }
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

  const release = (force: boolean): void => {
    if (api !== null && port !== 0) api.close(port);
    if (running !== null) {
      running.onmessage = null;
      running.onerror = null;
      if (force) running.terminate();
    }
  };
  if (running === null) {
    release(false);
    return Promise.resolve();
  }
  if (flag !== null) Atomics.store(flag, 0, 1);
  // The wait has no timeout: this packet is what wakes it to read the flag.
  if (api !== null && port !== 0) api.wakeToStop(port);
  return new Promise<void>((resolve) => {
    let released = false;
    const once = (force: boolean): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      release(force);
      resolve();
    };
    // The loop leaves on that packet and posts 'stopped'; the port closes then,
    // never while the worker may still be blocked on it. Closing it on the
    // fallback also ends a wait nothing woke.
    // 'stopped' only acknowledges the loop. Wait for Bun's close event before
    // a caller can dispose this core or load another isolated test context.
    running.addEventListener('close', () => once(false), { once: true });
    running.onmessage = (event: { data: unknown }): void => {
      const message = event.data as JobsWorkerMessage;
      if (message.kind === 'stopped') running.onmessage = null;
      else if (message.kind === 'packet' && message.handle !== 0) api?.close(message.handle);
    };
    const timer = setTimeout(() => once(true), 1000);
  });
}
