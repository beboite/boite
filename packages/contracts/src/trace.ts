import type { ProjectId, ProviderId, ThreadId, Timestamp } from './ids';
import type { Os } from './providers';
import type { MemoryEvent, MemoryStatus } from './scheduler';
import type { ThreadLoad, ThreadStatus } from './threads';

// ---------------------------------------------------------------------------
// Trace: every process a thread launched, with what it cost.
// ---------------------------------------------------------------------------

export interface ProcessRecord {
  pid: number;
  parentPid: number | null;
  threadId: ThreadId;
  exe: string;
  commandLine: string | null;
  startedAt: Timestamp;
  exitedAt: Timestamp | null;
  exitCode: number | null;
  cpuMs: number | null;
  peakMemoryBytes: number | null;
  ioBytes: number | null;
}

/**
 * The most recent processes `trace.get` returns when no limit is given, and
 * all a client keeps of a thread's trace as `process.*` events arrive.
 */
export const TRACE_LIMIT = 200;

/** A thread with at least one process running now; what exited stays in `trace.get`. */
export interface ThreadResources {
  threadId: ThreadId;
  title: string;
  status: ThreadStatus;
  live: ProcessRecord[];
  /** The latest sample of the whole tree, the same one `ThreadSummary.load` carries. */
  load: ThreadLoad;
}

/** Read and write mean storage reads/writes for disk, download/upload for network. */
export interface ResourceByteUsage {
  /** Observed deltas since `since`, never an unobserved conversation lifetime. */
  readBytes: number | null;
  writeBytes: number | null;
  /** Null until two readings of the same live counter establish an interval. */
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  sampledAt: Timestamp | null;
  since: Timestamp | null;
  coverage: 'partial' | 'unavailable';
  source: 'linux-proc-io' | 'linux-tcp-info' | 'macos-rusage' | 'unavailable';
  /** Short collector explanation; clients translate known sources and coverage. */
  note: string;
}

/** Sanitized resource row suitable for a paired phone; no paths or process arguments. */
export interface AgentResourceUsage {
  threadId: ThreadId;
  title: string;
  providerId: ProviderId;
  model: string | null;
  status: ThreadStatus;
  projectId: ProjectId | null;
  parentThreadId: ThreadId | null;
  load: ThreadLoad;
  /** Missing on an older core; false distinguishes unavailable readings from a measured zero. */
  loadAvailable?: { cpu: boolean; memory: boolean };
  disk: ResourceByteUsage;
  network: ResourceByteUsage;
}

export interface AgentResourceSnapshot {
  sampledAt: Timestamp;
  agents: AgentResourceUsage[];
}

/** What the trace can and cannot promise on this OS. */
export interface TraceCapability {
  os: Os;
  /** 'events' means exact (Windows job completion port); 'poll' may miss sub-second processes. */
  mode: 'events' | 'poll' | 'none';
  note: string;
}

export interface TraceRpcMethods {

  'trace.get': { params: { threadId: ThreadId; limit?: number }; result: ProcessRecord[] };
  'resources.list': { params: Record<string, never>; result: ThreadResources[] };
  /** Visible clients renew a six-second detail lease; false releases only this connection. */
  'resources.usage': { params: { watch?: boolean }; result: AgentResourceSnapshot };
  /** Owner-only machine memory reading and the limits actually applied by the governor. */
  'resources.memoryStatus': { params: Record<string, never>; result: MemoryStatus };
  'resources.killTree': { params: { threadId: ThreadId }; result: { killed: number } };
}

export interface TraceRpcEvents {
  'resources.memory': MemoryEvent;

  'process.started': ProcessRecord;
  'process.exited': ProcessRecord;
  /**
   * A window of a process this thread launched took the foreground and was sent
   * back behind everything without activation. `restored` says whether the
   * window the user was on got the focus back. Windows only.
   */
  'process.focusPushed': {
    threadId: ThreadId;
    pid: number;
    title: string;
    restored: boolean;
    at: Timestamp;
  };
  /**
   * An audio session of a process this thread launched was muted, and stays
   * muted until that process exits. Windows only.
   */
  'process.muted': { threadId: ThreadId; pid: number; at: Timestamp };
}
