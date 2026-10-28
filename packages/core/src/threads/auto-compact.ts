import { effectiveCompaction } from '@boite/contracts';
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
/**
 * The `cacheKeepalive` setting's timings (`threads/cache-keepalive.ts`).
 * `marginMs`: how long before the prompt cache lapses a ping goes out, wide
 * enough for a ping that waits for a slot or for its first token. `retryMs`:
 * how soon a ping that found something else about to run looks again.
 * Mutable so a test can shorten them.
 */
export const CACHE_KEEPALIVE = { marginMs: 120_000, retryMs: 5_000 };
/** What the opening message of an automatic compaction is labelled. */
export const AUTO_COMPACT_LABEL = 'Automatic compaction';

/**
 * The `autoCompact` setting at work. A turn that ends well arms one timer for
 * its thread, at the independent token limit or the first chosen idle moment;
 * any turn that opens
 * before it fires disarms it. Everything is checked again when it fires, so a
 * thread that got busy, archived or no longer qualifies is left alone. The compaction
 * is the same scheduled turn `threads.compact` opens, marked `automatic`, unless
 * a copy compacted in the background takes its place (`threads/background-compact.ts`).
 */
export class AutoCompaction {
  private readonly timers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private readonly unlisten: () => void;

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    // An ACP agent names its commands only once its session is prepared, after the client showed the thread.
    this.unlisten = core.bus.onCommitted((name, payload) => {
      if (name !== 'thread.commands') return;
      const { threadId } = payload as { threadId: ThreadId };
      if (this.threads.focus.viewed(threadId)) queueMicrotask(() => this.shown(threadId));
    });
  }

  /** Called once a finished turn and its thread are saved. */
  turnFinished(thread: ThreadSummary, turn: Turn): void {
    this.cancel(thread.id);
    // A copy compacting in the background (`backgroundCompaction`) is checked, dropped or started first.
    this.threads.backgroundCompact.turnFinished(thread, turn);
    // A stop or a failure is the user's to look at; a compaction never chains into another.
    if (turn.status !== 'done' || turn.execution?.operation === 'compact') return;
    const rule = effectiveCompaction(this.core.settings.get(), thread).autoCompact;
    if (!rule || this.refusal(thread) !== null) return;
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

  /** A planned compaction replaces a cache keepalive rather than being postponed by its ping. */
  planned(threadId: ThreadId): boolean { return this.timers.has(threadId); }

  /** A background copy finished or failed: an idle thread takes it, or compacts if it is due, now. */
  recheck(threadId: ThreadId): void {
    this.cancel(threadId);
    this.fire(threadId);
  }

  /**
   * A client shows an idle thread already at its token limit: one that went
   * quiet before the limit was lowered, or whose timer a restart dropped. A
   * copy compacted in the background starts only below the limit, and its next
   * prompt would wait for the agent to compact first, so it compacts now, while
   * the user reads and types. As after a turn, a stop or a failure is the
   * user's to look at, and a compaction never chains into another, even one
   * that kept more than the limit: the last turn decides.
   */
  shown(threadId: ThreadId): void {
    if (this.core.stopping || this.core.journal.isClosed()) return;
    const thread = this.core.journal.getThread(threadId);
    const reading = thread?.context ?? null;
    if (thread === null || reading === null) return;
    const limit = effectiveCompaction(this.core.settings.get(), thread).autoCompact?.tokens ?? null;
    if (limit === null || reading.tokens < limit) return;
    // A keepalive's ping says nothing of the conversation, as after a turn.
    const last = this.core.journal.lastTurn(threadId, true);
    if (last !== null && (last.status !== 'done' || last.execution?.operation === 'compact')) return;
    // A timer armed below an older limit, for the cache's moment, would wait minutes: the moment is worked out again.
    this.recheck(threadId);
  }

  /** Done lets the final answer finish, but has no further context to prepare. */
  stopIfDone(threadId: ThreadId): void {
    const thread = this.core.journal.getThread(threadId);
    if (!thread?.archived || thread.doneAt == null) return;
    this.cancel(threadId);
    if (this.core.journal.runningTurn(threadId)?.execution?.operation === 'compact'
      || this.threads.progress.get(threadId)?.phase === 'compacting') this.core.scheduler.stop(threadId);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.unlisten();
  }

  /**
   * The first chosen moment that applies to the thread as it stands, and how
   * long from now it comes: the settle delay counted from the end of the last
   * turn for the token limit, or the cache's last minute. Null when none applies.
   */
  private due(thread: ThreadSummary, rule: AutoCompact): { moment: AutoCompactMoment | 'tokens' | 'copy'; delay: number } | null {
    const reached = rule.tokens !== null && (thread.context?.tokens ?? -1) >= rule.tokens;
    const settled = Math.max(0, thread.updatedAt + AUTO_COMPACT.settleMs - Date.now());
    // Native drivers enforce this inside a turn where supported. An idle
    // session still needs a fallback, independently of its selected moments.
    if (reached) return { moment: 'tokens', delay: settled };
    // The agent compacts by itself once a turn crosses the limit, and a session
    // changes only between turns: a copy compacted in the background is taken at the first pause.
    if (this.threads.backgroundCompact.ready(thread.id)) return { moment: 'copy', delay: settled };
    const waiting = (this.threads.agentState.background.get(thread.id)?.length ?? 0) > 0;
    const moment: AutoCompactMoment = waiting ? 'background' : 'turn-end';
    if (rule.tokens === null && rule.moments.includes(moment)) return { moment, delay: settled };
    const cache = thread.promptCache ?? null;
    if (!rule.moments.includes('cache-expiry') || cache === null) return null;
    // Another model or account starts cold: there is no cached reading left to save.
    if (cache.model !== thread.model || cache.accountId !== thread.accountId) return null;
    return { moment: 'cache-expiry', delay: Math.max(0, cache.at + cache.ttlSeconds * 1000 - AUTO_COMPACT.cacheMarginMs - Date.now()) };
  }

  /** Why this thread is not compacted now, or null. */
  private refusal(thread: ThreadSummary): string | null {
    if (thread.archived) return 'archived';
    return this.threads.compactRefusal(thread);
  }

  private fire(threadId: ThreadId): void {
    if (this.core.stopping || this.core.journal.isClosed()) return;
    const thread = this.core.journal.getThread(threadId);
    if (thread === null) return;
    const rule = effectiveCompaction(this.core.settings.get(), thread).autoCompact;
    if (!rule || thread.status !== 'idle') return;
    if (this.threads.runner.handles.has(threadId) || this.threads.runner.steering.has(threadId)) return;
    if (this.refusal(thread) !== null || this.expected(threadId)) return;
    // The setting or the background work may have changed since the timer was
    // armed: the moment is worked out again, and one that lies ahead waits for its own time.
    const due = this.due(thread, rule);
    if (due === null) return;
    if (due.delay > 0) { this.arm(threadId, due.delay); return; }
    // A copy compacted in the background replaces the turn, or one still running is waited for.
    if (this.threads.backgroundCompact.due(thread) !== null || due.moment === 'copy') return;
    try {
      this.threads.compact(threadId, undefined, true);
    } catch (error) {
      this.core.log('info', `thread ${threadId}: automatic compaction skipped: ${messageOf(error)}`);
    }
  }

  /**
   * Whether something is about to open a turn here by itself. Its `startTurn`
   * would be refused by a compaction in flight, and a refused result, wake or
   * iteration must not wait behind maintenance. Children working elsewhere
   * are not pending input: their eventual results stay in the inbox.
   */
  private expected(threadId: ThreadId): boolean {
    if (this.threads.deferred.pendingWakes.has(threadId) || this.threads.deferred.deferredAnswers.has(threadId) || this.threads.deferred.consumed.has(threadId)) return true;
    if (this.threads.autoContinue.retryOf(threadId) !== null) return true;
    const activity = this.core.activity.get(threadId);
    if (activity.goal?.status === 'active' || activity.loop?.status === 'active') return true;
    try {
      // Work elsewhere can last hours. Only mail already waiting to open
      // this thread's next turn takes precedence; later results stay queued.
      if (this.core.delegation.hasMail(threadId)) return true;
    } catch (error) {
      this.core.log('warn', `thread ${threadId}: automatic compaction could not read its agents: ${messageOf(error)}`);
      return true;
    }
    return false;
  }
}
