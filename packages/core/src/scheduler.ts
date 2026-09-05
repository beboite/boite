import type { AccountId, SchedulerState, ThreadId, Timestamp, Turn, TurnId } from '@boite/contracts';
import type { Core } from './core.ts';

interface Entry {
  turnId: TurnId;
  threadId: ThreadId;
  accountId: AccountId;
  queuedAt: Timestamp;
}

interface RunningEntry extends Entry {
  startedAt: Timestamp;
  done: Promise<void>;
}

/**
 * A thread is not a process: this counts turns. A turn past `maxConcurrentTurns`
 * or past `perAccountConcurrency` waits in order and is visible as `queued`.
 */
export class Scheduler {
  private readonly queue: Entry[] = [];
  private readonly running = new Map<TurnId, RunningEntry>();

  constructor(private readonly core: Core) {}

  enqueue(turn: Turn, accountId: AccountId): void {
    this.queue.push({ turnId: turn.id, threadId: turn.threadId, accountId, queuedAt: turn.queuedAt });
    this.emitUpdated();
    this.pump();
  }

  state(): SchedulerState {
    const settings = this.core.settings.get();
    return {
      maxConcurrentTurns: settings.maxConcurrentTurns,
      perAccountConcurrency: settings.perAccountConcurrency,
      running: [...this.running.values()].map((entry) => ({
        turnId: entry.turnId,
        threadId: entry.threadId,
        startedAt: entry.startedAt,
      })),
      queued: this.queue.map((entry, index) => ({
        turnId: entry.turnId,
        threadId: entry.threadId,
        position: index,
        queuedAt: entry.queuedAt,
      })),
    };
  }

  onSettingsChanged(): void {
    this.emitUpdated();
    this.pump();
  }

  stop(threadId: ThreadId): boolean {
    const running = [...this.running.values()].find((entry) => entry.threadId === threadId);
    if (running !== undefined) return this.core.threads.stopRunning(threadId);

    const index = this.queue.findIndex((entry) => entry.threadId === threadId);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    if (entry === undefined) return false;
    this.core.threads.markQueuedStopped(entry.turnId);
    this.emitUpdated();
    return true;
  }

  private pump(): void {
    const settings = this.core.settings.get();
    let started = false;
    for (;;) {
      if (this.running.size >= settings.maxConcurrentTurns) break;
      const index = this.queue.findIndex(
        (entry) => this.runningForAccount(entry.accountId) < settings.perAccountConcurrency,
      );
      if (index < 0) break;
      const [entry] = this.queue.splice(index, 1);
      if (entry === undefined) break;
      this.start(entry);
      started = true;
    }
    if (started) this.emitUpdated();
  }

  private start(entry: Entry): void {
    const done = this.core.threads.runTurn(entry.turnId, entry.threadId).finally(() => {
      this.running.delete(entry.turnId);
      if (this.core.journal.isClosed()) return;
      this.pump();
      this.emitUpdated();
    });
    this.running.set(entry.turnId, { ...entry, startedAt: Date.now(), done });
  }

  /** Shutdown: drop the queue, stop what runs, and wait for it before the journal closes. */
  async drain(): Promise<void> {
    this.queue.length = 0;
    const entries = [...this.running.values()];
    for (const entry of entries) this.core.threads.stopRunning(entry.threadId);
    await Promise.allSettled(entries.map((entry) => entry.done));
  }

  private runningForAccount(accountId: AccountId): number {
    let count = 0;
    for (const entry of this.running.values()) if (entry.accountId === accountId) count += 1;
    return count;
  }

  private emitUpdated(): void {
    this.core.bus.emit('scheduler.updated', this.state());
  }
}

export function registerSchedulerMethods(core: Core): void {
  core.router.register('scheduler.get', () => core.scheduler.state());
}
