import type { MessageId, ThreadId, Timestamp, TurnId } from './ids';
import type { Turn } from './turns';

// ---------------------------------------------------------------------------
// Scheduler: a thread is not a process. A process exists only while a turn runs.
// ---------------------------------------------------------------------------

export interface SchedulerState {
  running: { turnId: TurnId; threadId: ThreadId; startedAt: Timestamp }[];
  queued: { turnId: TurnId; threadId: ThreadId; position: number; queuedAt: Timestamp; queueHold?: Turn['queueHold'] }[];
}

export type MemoryState = 'ok' | 'critical';

export interface MemoryStatus {
  state: MemoryState;
  agentBytes: number;
  availableBytes: number | null;
  /** All zero when protection is off; usage readings remain available. */
  limits: { budgetMb: number; threadMemoryCapMb: number; memoryReserveMb: number };
}

interface MemoryEventBase {
  threadId: string | null;
  pid?: number;
  exe?: string;
  bytes?: number;
  state: MemoryState;
  at: number;
  /** Insert after the parts present when this notice arrived, including after reload. */
  anchor?: { messageId: MessageId; partIndex: number };
}

export type MemoryKillReason = 'thread-quota' | 'budget' | 'machine';

export type MemoryEvent = MemoryEventBase & (
  | { kind: 'killed'; reason: MemoryKillReason; limitBytes: number }
  | { kind: 'thread-cap' | 'budget' | 'pressure' }
  /**
   * Linux: the thread's cgroup keeps hitting `memory.high` (`limitBytes`), so its
   * processes stall instead of failing. `bytes` is the group's current charge.
   */
  | { kind: 'throttled'; limitBytes: number }
);

export interface SchedulerRpcMethods {

  'scheduler.get': { params: Record<string, never>; result: SchedulerState };
}

export interface SchedulerRpcEvents {

  'scheduler.updated': SchedulerState;
}
