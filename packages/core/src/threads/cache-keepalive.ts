import type { ThreadId, ThreadSummary, Turn, TurnId, Usage } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { KEEPALIVE_PING_CAP } from '../prompt-cache.ts';
import type { ThreadStore } from '../threads.ts';
import { CACHE_KEEPALIVE } from './auto-compact.ts';

/** What a ping asks: an answer of one word, so it reads the cached prefix and writes almost nothing. */
export const KEEPALIVE_PROMPT = 'Cache keepalive: reply ok, no tools.';
/** What the opening message of a ping is labelled. */
export const KEEPALIVE_LABEL = 'Prompt cache kept warm';

const BUSY = ['queued', 'running', 'waiting'];

/**
 * One wait of a thread on its agents: from the end of its last real turn,
 * the pings sent since, and the timer of the next one. `armed` once a ping
 * was planned, so a thread that never qualified ends its wait in silence.
 */
interface Wait {
  since: number;
  pings: number;
  timer: ReturnType<typeof setTimeout> | null;
  armed: boolean;
}

/**
 * The `cacheKeepalive` setting at work (`docs/prompt-cache.md`, "Keeping the
 * cache warm"). A thread of the user's that finishes a turn while its
 * delegated agents or workflows still run starts a wait. Shortly before its
 * prompt cache lapses, a minimal automatic turn reads the cached prefix again
 * and restarts the lifetime, so the result that ends the wait is read from the
 * cache instead of written again in full.
 *
 * Each ping is planned from the cache the last turn left, and everything is
 * checked again when it fires. A ping that missed the cache, the duration of
 * the setting, or as many pings as one miss would cost, ends the wait. A
 * result, a user message or a stop always wins: a ping never takes what was
 * meant for the thread, and a result that comes in during one stops it.
 */
export class CacheKeepalive {
  private readonly waits = new Map<ThreadId, Wait>();
  /** The pings already asked to stop for a result, so a second letter does not stop them again. */
  private readonly yielded = new Set<TurnId>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  /** Called once a finished turn and its thread are saved, in the same session. */
  turnFinished(thread: ThreadSummary, turn: Turn): void {
    const wait = this.waits.get(thread.id);
    this.clearTimer(wait);
    this.yielded.delete(turn.id);
    if (turn.execution?.operation === 'keepalive') {
      if (wait === undefined) return;
      const miss = turn.status !== 'done' ? `the ping ended ${turn.status}` : missOf(turn.usage);
      if (miss !== null) { this.end(thread.id, miss, turn.id); return; }
      wait.pings += 1;
      this.arm(thread, wait);
      return;
    }
    this.waits.delete(thread.id);
    // A stop or a failure is the user's to look at: no ping keeps it company.
    if (turn.status !== 'done' || !this.core.settings.get().cacheKeepalive) return;
    const next: Wait = { since: turn.finishedAt ?? Date.now(), pings: 0, timer: null, armed: false };
    this.waits.set(thread.id, next);
    this.arm(thread, next);
  }

  /** Any turn opening disarms the next ping; a real one's end plans a new wait. */
  cancel(threadId: ThreadId): void {
    this.clearTimer(this.waits.get(threadId));
  }

  /** The user stopped the thread: its wait ends here. */
  forget(threadId: ThreadId): void {
    const wait = this.waits.get(threadId);
    if (wait !== undefined) this.end(threadId, 'the thread was stopped');
  }

  close(): void {
    for (const wait of this.waits.values()) this.clearTimer(wait);
    this.waits.clear();
    this.yielded.clear();
  }

  /** Whether the thread's turn in flight is a ping: it takes no steering, it gives way. */
  pinging(threadId: ThreadId): boolean {
    const turn = this.core.journal.lastTurn(threadId);
    return turn !== null && (turn.status === 'queued' || turn.status === 'running') && turn.execution?.operation === 'keepalive';
  }

  /**
   * Something meant for the thread came in while a ping holds it: the ping is
   * stopped and the wait ends, so the result goes on the `turn.finished` that
   * follows. True when there was a ping in the way.
   */
  yieldTo(threadId: ThreadId): boolean {
    const turn = this.core.journal.lastTurn(threadId);
    if (turn === null || (turn.status !== 'queued' && turn.status !== 'running') || turn.execution?.operation !== 'keepalive') return false;
    if (this.yielded.has(turn.id)) return true;
    this.yielded.add(turn.id);
    this.end(threadId, 'a result came in', turn.id, true);
    this.core.scheduler.stop(threadId);
    return true;
  }

  private arm(thread: ThreadSummary, wait: Wait): void {
    const plan = this.plan(thread, wait);
    if (typeof plan === 'string') { this.end(thread.id, plan); return; }
    wait.armed = true;
    this.schedule(thread.id, wait, plan - Date.now());
  }

  private schedule(threadId: ThreadId, wait: Wait, delay: number): void {
    this.clearTimer(wait);
    const timer = setTimeout(() => {
      wait.timer = null;
      this.fire(threadId);
    }, Math.max(0, delay));
    timer.unref?.();
    wait.timer = timer;
  }

  /**
   * When the next ping goes, or why there is none: the cache's lapse less
   * the margin, as long as the thread still qualifies, the cap and the
   * duration allow one more, and the cache has not lapsed already.
   */
  private plan(thread: ThreadSummary, wait: Wait): number | string {
    const setting = this.core.settings.get().cacheKeepalive;
    if (!setting) return 'the setting is off';
    if (thread.archived) return 'the thread is archived';
    // A delegated agent answers its parent, who has the cache that matters.
    if (thread.parentThreadId) return 'not a conversation of the user';
    if (thread.sessionId === null) return 'the thread has no session to resume';
    const waiting = this.waiting(thread.id);
    if (waiting !== true) return waiting;
    const cache = thread.promptCache ?? null;
    if (cache === null) return 'the thread shows no prompt cache';
    // Another model or account starts cold: there is no cached prefix to keep.
    if (cache.model !== thread.model || cache.accountId !== thread.accountId) return 'the cache is of another model or account';
    const last = this.core.journal.lastEndedTurn(thread.id)?.execution;
    // The same effort and speed as the request that wrote the cache, so a ping sends the same prefix.
    if (last && (last.effort !== thread.effort || (last.speed ?? null) !== (thread.speed ?? null))) return 'the thread\'s effort or speed changed since its last turn';
    const cap = KEEPALIVE_PING_CAP[cache.ttlSeconds];
    if (cap === undefined) return `no known break-even for a ${cache.ttlSeconds} s cache`;
    if (wait.pings >= cap) return `the cap of ${cap} pings for one wait is reached`;
    const lapse = cache.at + cache.ttlSeconds * 1000;
    if (lapse <= Date.now()) return 'the cache already lapsed';
    const at = lapse - CACHE_KEEPALIVE.marginMs;
    if (at > wait.since + setting.hours * 3_600_000) return `the ${setting.hours} h of the setting are over`;
    return at;
  }

  /** True while a delegated agent of the thread works or a workflow of it runs, otherwise why not. */
  private waiting(threadId: ThreadId): true | string {
    try {
      if (this.core.delegation.get(threadId).agents.some((agent) => BUSY.includes(agent.thread.status))) return true;
      if (this.core.workflows.list(threadId).some((run) => run.status === 'running')) return true;
    } catch (error) {
      return `its agents could not be read: ${messageOf(error)}`;
    }
    return 'no agent or workflow left to wait for';
  }

  /**
   * Whether something else is about to open a turn here: that turn comes
   * first, and the ping looks again a little later.
   */
  private expected(threadId: ThreadId): boolean {
    // Keep the wait and recheck: cancelling compaction must allow the next
    // ping without requiring another conversation turn to rebuild the wait.
    if (this.threads.autoCompact.planned(threadId)) return true;
    if (this.threads.runner.handles.has(threadId) || this.threads.runner.steering.has(threadId)) return true;
    const deferred = this.threads.deferred;
    if (deferred.pendingWakes.has(threadId) || deferred.deferredAnswers.has(threadId) || deferred.consumed.has(threadId)) return true;
    const activity = this.core.activity.get(threadId);
    if (activity.goal?.status === 'active' || activity.loop?.status === 'active') return true;
    return this.core.delegation.hasMail(threadId);
  }

  private fire(threadId: ThreadId): void {
    const wait = this.waits.get(threadId);
    if (wait === undefined || this.core.stopping || this.core.journal.isClosed()) return;
    const thread = this.core.journal.getThread(threadId);
    if (thread === null) { this.waits.delete(threadId); return; }
    // A turn in flight plans the next ping when it ends.
    if (thread.status !== 'idle') return;
    const plan = this.plan(thread, wait);
    if (typeof plan === 'string') { this.end(threadId, plan); return; }
    // The setting or the cache moved since the timer was armed: a ping that lies ahead waits for its time.
    if (plan > Date.now()) { this.schedule(threadId, wait, plan - Date.now()); return; }
    if (this.expected(threadId)) { this.schedule(threadId, wait, CACHE_KEEPALIVE.retryMs); return; }
    try {
      const turn = this.threads.startTurn(threadId, KEEPALIVE_PROMPT, [], undefined, 'keepalive', undefined, undefined, KEEPALIVE_LABEL);
      this.log('info', threadId, `Prompt cache keepalive ping ${wait.pings + 1} sent`, 'cache-keepalive.ping', turn.id, { pings: wait.pings + 1 });
    } catch (error) {
      this.end(threadId, `the ping was refused: ${messageOf(error)}`);
    }
  }

  private end(threadId: ThreadId, reason: string, turnId?: TurnId, yielded = false): void {
    const wait = this.waits.get(threadId);
    if (wait === undefined) return;
    this.clearTimer(wait);
    this.waits.delete(threadId);
    if (wait.armed || yielded) this.log('info', threadId, `Prompt cache keepalive ended: ${reason}`, 'cache-keepalive.ended', turnId, { reason, pings: wait.pings });
  }

  private clearTimer(wait: Wait | undefined): void {
    if (wait?.timer == null) return;
    clearTimeout(wait.timer);
    wait.timer = null;
  }

  private log(level: 'info' | 'warn', threadId: ThreadId, message: string, event: string, turnId: TurnId | undefined, data: Record<string, string | number>): void {
    try {
      this.core.logs.record(level, message, { source: 'turns', event, threadId, ...(turnId ? { turnId } : {}), data });
    } catch { /* the wait stands without its record */ }
  }
}

/**
 * Why a ping's usage shows it missed the cache, or null when it hit: less
 * than half of what it sent was read from the cache. On Anthropic a miss
 * writes the prefix again, on OpenAI it bills it as fresh input; either way
 * the read falls short. No usage cannot tell, and ends the wait too.
 */
export function missOf(usage: Usage | null): string | null {
  if (usage === null) return 'the ping reported no usage';
  const sent = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (sent <= 0) return 'the ping reported no usage';
  if (usage.cacheReadTokens * 2 >= sent) return null;
  return `the ping missed the cache (${usage.cacheReadTokens} of ${sent} tokens read, ${usage.cacheWriteTokens} written)`;
}
