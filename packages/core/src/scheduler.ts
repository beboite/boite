import type { AccountId, ProviderId, SchedulerState, ThreadId, Timestamp, Turn, TurnId } from '@boite/contracts';
import type { Core } from './core.ts';
import { logMessageOf } from './log-errors.ts';

interface Entry {
  turnId: TurnId;
  threadId: ThreadId;
  accountId: AccountId;
  /** The provider the accepted turn runs on, whatever the thread selects since. */
  providerId: ProviderId | undefined;
  queuedAt: Timestamp;
  reportedQueued: boolean;
  queueHold?: Turn['queueHold'];
}

interface RunningEntry extends Entry {
  startedAt: Timestamp;
  done: Promise<void>;
}

/** How long `drain()` waits for running turns before shutdown moves on. */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Starts independent threads immediately. A paused team or account login
 * change can hold admission; each thread still has one in-flight turn.
 */
export class Scheduler {
  private readonly queue = new Map<TurnId, Entry>();
  private readonly running = new Map<ThreadId, RunningEntry>();
  private pendingUpdate = false;

  constructor(private readonly core: Core) {}

  /** Account ownership follows accepted turns even when their thread selects another model. */
  activeAccountIds(): AccountId[] {
    return [...new Set([...this.queue.values(), ...this.running.values()].map((entry) => entry.accountId))];
  }

  enqueue(turn: Turn, accountId: AccountId): void {
    if (this.running.get(turn.threadId)?.turnId === turn.id) return;
    const entry = { turnId: turn.id, threadId: turn.threadId, accountId, providerId: turn.execution?.providerId, queuedAt: turn.queuedAt, reportedQueued: false, queueHold: turn.queueHold };
    this.queue.set(turn.id, entry);
    this.pump([entry]);
    this.emitUpdated();
  }

  state(): SchedulerState {
    return {
      running: [...this.running.values()].map((entry) => ({
        turnId: entry.turnId,
        threadId: entry.threadId,
        startedAt: entry.startedAt,
      })),
      queued: Array.from(this.queue.values(), (entry, index) => ({
        turnId: entry.turnId,
        threadId: entry.threadId,
        position: index,
        queuedAt: entry.queuedAt,
        ...(entry.queueHold ? { queueHold: entry.queueHold } : {}),
      })),
    };
  }

  onSettingsChanged(): void {
    this.pump();
    this.emitUpdated();
  }

  /** Something that held queued turns let go of them: an agent update finished. */
  retry(): void {
    this.pump();
  }

  stop(threadId: ThreadId): boolean {
    if (this.running.has(threadId)) return this.core.threads.stopRunning(threadId);

    for (const entry of this.queue.values()) {
      if (entry.threadId !== threadId) continue;
      this.recordQueued(entry);
      this.core.threads.markQueuedStopped(entry.turnId);
      this.queue.delete(entry.turnId);
      this.emitUpdated();
      return true;
    }
    return false;
  }

  async stopAndWait(threadId: ThreadId): Promise<void> {
    const entry = this.running.get(threadId);
    this.stop(threadId);
    await entry?.done;
  }

  private pump(entries: Iterable<Entry> = this.queue.values()): void {
    if (this.core.stopping) return;
    // Settings and completions repump held entries; enqueue checks only its new turn.
    // Broad Map iteration still follows a reentrant start's additions and removals.
    for (const entry of entries) {
      if (entry.queueHold || !this.core.delegation.canRun(entry.threadId)
        || this.core.plugins.blocksAccount(entry.accountId)
        // A program being replaced cannot start a turn; it starts once the updater is done.
        || this.core.updates.holds(entry.providerId)
        || this.running.has(entry.threadId)) continue;
      this.queue.delete(entry.turnId);
      this.start(entry);
    }
  }

  private start(entry: Entry): void {
    this.recordQueued(entry);
    const done = this.core.threads.runTurn(entry.turnId, entry.threadId).catch(error => {
      if (!this.core.journal.isClosed()) this.core.log('error', `turn finalization failed: ${logMessageOf(error)}`, { source: 'scheduler', event: 'turn.finalization-failed', threadId: entry.threadId, turnId: entry.turnId });
    }).finally(() => {
      this.running.delete(entry.threadId);
      if (this.core.journal.isClosed()) return;
      this.pump();
      this.emitUpdated();
    });
    this.running.set(entry.threadId, { ...entry, startedAt: Date.now(), done });
  }

  /** Shutdown: drop the queue, stop what runs, and wait for it before the journal closes. */
  async drain(timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<void> {
    if (!this.core.journal.isClosed()) {
      // A restart handoff carries its queued turns to the next core as they are.
      for (const entry of this.queue.values()) {
        this.recordQueued(entry);
        if (!entry.queueHold && !this.core.threads.handoff.keepsQueued(entry.turnId)) this.core.threads.markQueuedStopped(entry.turnId);
      }
    }
    this.queue.clear();
    this.emitUpdated();
    const entries = [...this.running.values()];
    for (const entry of entries) this.core.threads.stopRunning(entry.threadId);
    if (entries.length === 0) return;
    // A driver that never answers its stop used to hang this wait for ever,
    // and with it the whole shutdown. What is still running past the deadline
    // is left to the process kill that follows.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    await Promise.race([Promise.allSettled(entries.map((entry) => entry.done)), deadline]);
    if (timer !== undefined) clearTimeout(timer);
  }

  private emitUpdated(): void {
    if (this.pendingUpdate) return;
    this.pendingUpdate = true;
    queueMicrotask(() => {
      this.pendingUpdate = false;
      if (this.core.journal.isClosed()) return;
      for (const entry of this.queue.values()) entry.reportedQueued = true;
      this.core.bus.emit('scheduler.updated', this.state());
    });
  }

  /** A turn can leave the queue before a snapshot records its queued diagnostic. */
  private recordQueued(entry: Entry): void {
    if (entry.reportedQueued) return;
    entry.reportedQueued = true;
    this.core.logs.record('info', 'Turn queued', { source: 'scheduler', event: 'turn.queued', threadId: entry.threadId, turnId: entry.turnId }, entry.queuedAt);
  }
}

export function registerSchedulerMethods(core: Core): void {
  core.router.register('scheduler.get', () => core.scheduler.state());
}
