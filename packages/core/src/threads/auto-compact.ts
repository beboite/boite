import type { AutoCompact, AutoCompactMoment, ThreadId, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';

/**
 * `settleMs`: how long a finished turn is left alone before the core compacts,
 * so a client's queued prompt, a wake or a held answer opens its turn first.
 * `cacheMarginMs`: how long before the prompt cache lapses the `cache-expiry`
 * moment fires. Mutable so a test can shorten them.
 */
export const AUTO_COMPACT = { settleMs: 2_000, cacheMarginMs: 60_000 };
/** What the opening message of an automatic compaction is labelled. */
export const AUTO_COMPACT_LABEL = 'Automatic compaction';

const BUSY = ['queued', 'running', 'waiting'];

/**
 * The `autoCompact` setting at work. A turn that ends well arms one timer for
 * its thread, at the first chosen moment that applies; any turn that opens
 * before it fires disarms it. Everything is checked again when it fires, so a
 * thread that got busy, archived or small again is left alone. The compaction
 * is the same scheduled turn `threads.compact` opens, marked `automatic`.
 */
export class AutoCompaction {
  private readonly timers = new Map<ThreadId, ReturnType<typeof setTimeout>>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  /** Called once a finished turn and its thread are saved. */
  turnFinished(thread: ThreadSummary, turn: Turn): void {
    this.cancel(thread.id);
    // A stop or a failure is the user's to look at; a compaction never chains into another.
    if (turn.status !== 'done' || turn.execution?.operation === 'compact') return;
    const rule = this.core.settings.get().autoCompact;
    if (!rule || this.refusal(thread, rule) !== null) return;
    const due = this.due(thread, rule);
    if (due !== null) this.arm(thread.id, due.delay);
  }

  private arm(threadId: ThreadId, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      this.fire(threadId);
    }, delay);
    timer.unref?.();
    this.timers.set(threadId, timer);
  }

  cancel(threadId: ThreadId): void {
    const timer = this.timers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(threadId);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * The first chosen moment that applies to the thread as it stands, and how
   * long from now it comes: the settle delay counted from the end of the last
   * turn, or the cache's last minute. Null when none applies.
   */
  private due(thread: ThreadSummary, rule: AutoCompact): { moment: AutoCompactMoment; delay: number } | null {
    const waiting = (this.threads.agentState.background.get(thread.id)?.length ?? 0) > 0;
    const moment: AutoCompactMoment = waiting ? 'background' : 'turn-end';
    if (rule.moments.includes(moment)) return { moment, delay: Math.max(0, thread.updatedAt + AUTO_COMPACT.settleMs - Date.now()) };
    const cache = thread.promptCache ?? null;
    if (!rule.moments.includes('cache-expiry') || cache === null) return null;
    // Another model or account starts cold: there is no cached reading left to save.
    if (cache.model !== thread.model || cache.accountId !== thread.accountId) return null;
    return { moment: 'cache-expiry', delay: Math.max(0, cache.at + cache.ttlSeconds * 1000 - AUTO_COMPACT.cacheMarginMs - Date.now()) };
  }

  /** Why this thread is not compacted now, or null. */
  private refusal(thread: ThreadSummary, rule: AutoCompact): string | null {
    if (thread.archived) return 'archived';
    // A resident agent compacts by its own `compactAfterTurns`; a delegated one answers its parent and ends.
    if (thread.agentSessionId || thread.parentThreadId) return 'not a conversation of the user';
    if (rule.tokens !== null && (thread.context ?? null) === null) return 'no context reading';
    if (rule.tokens !== null && thread.context!.tokens < rule.tokens) return 'below the threshold';
    return this.threads.compactRefusal(thread);
  }

  private fire(threadId: ThreadId): void {
    if (this.core.stopping || this.core.journal.isClosed()) return;
    const rule = this.core.settings.get().autoCompact;
    const thread = this.core.journal.getThread(threadId);
    if (!rule || thread === null || thread.status !== 'idle') return;
    if (this.threads.runner.handles.has(threadId) || this.threads.runner.steering.has(threadId)) return;
    if (this.refusal(thread, rule) !== null || this.expected(threadId)) return;
    // The setting or the background work may have changed since the timer was
    // armed: the moment is worked out again, and one that lies ahead waits for its own time.
    const due = this.due(thread, rule);
    if (due === null) return;
    if (due.delay > 0) { this.arm(threadId, due.delay); return; }
    try {
      this.threads.compact(threadId, undefined, true);
    } catch (error) {
      this.core.log('info', `thread ${threadId}: automatic compaction skipped: ${messageOf(error)}`);
    }
  }

  /**
   * Whether something is about to open a turn here by itself. Its `startTurn`
   * would be refused by a compaction in flight, and a refused result, wake or
   * iteration is lost or pauses its owner.
   */
  private expected(threadId: ThreadId): boolean {
    if (this.threads.deferred.pendingWakes.has(threadId) || this.threads.deferred.deferredAnswers.has(threadId) || this.threads.deferred.consumed.has(threadId)) return true;
    const activity = this.core.activity.get(threadId);
    if (activity.goal?.status === 'active' || activity.loop?.status === 'active') return true;
    try {
      if (this.core.delegation.get(threadId).agents.some((agent) => BUSY.includes(agent.thread.status))) return true;
      if (this.core.workflows.list(threadId).some((run) => run.status === 'running')) return true;
    } catch (error) {
      this.core.log('warn', `thread ${threadId}: automatic compaction could not read its agents: ${messageOf(error)}`);
      return true;
    }
    return false;
  }
}
