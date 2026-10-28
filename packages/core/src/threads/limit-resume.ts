import type { RpcEvents, Settings, ThreadId, ThreadRetry, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';
import { withLoad } from './records.ts';

/**
 * `marginMs`: how long after a window's reset the thread resumes, so the
 * provider has rolled it over. `startDelayMs`: the least a plan waits after a
 * core start, so the start finishes first. Mutable so a test can shorten them.
 */
export const LIMIT_RESUME = { marginMs: 60_000, startDelayMs: 2_000 };
/** What the resumed turn tells the agent; its own session holds the rest. */
export const LIMIT_RESUME_PROMPT = 'Your previous turn stopped because the subscription usage limit was reached. That limit has reset. Continue the current task from where it stopped, without repeating completed work.';
/** How the resumed turn's opening reads in the conversation. */
export const LIMIT_RESUME_LABEL = 'Resumed after the usage limit reset';

/** The journal setting holding every planned resume and the last window each thread resumed after. */
const KEY = 'limit-resumes';
/** Two readings of the same window can differ by the second their reset was rounded to. */
const SAME_WINDOW_MS = 120_000;

interface Plan {
  turnId: TurnId;
  resetsAt: number;
  at: number;
  providerId: string;
  accountId: string;
  model: string | null;
  sessionGeneration: number;
  /**
   * Written just before the turn is dispatched. A core that finds a plan in
   * this state at start cannot know whether that turn went out: it drops it.
   */
  dispatching?: true;
}

interface Entry {
  plan?: Plan;
  /** The reset of the window this thread last resumed after: one automatic resume per window. */
  resumedWindow?: number;
}

type Record_ = Record<ThreadId, Entry>;

/**
 * The opt-in `autoResumeLimitedThreads` at work. A turn that failed on a spent
 * subscription window plans one resume for its thread, a little after that
 * window resets: the reset the agent reported, else the spent window of the
 * account's quota reading. The plan is journalled, so it survives a restart,
 * and everything is checked again when it fires: a thread answered, stopped,
 * archived, switched to another account, model or provider, a paused team or
 * a pending approval cancels it. A failure that reports a window already
 * reset plans nothing, and a thread resumes once per window, so a limit
 * never turns into a retry loop.
 */
export class LimitResumes {
  private readonly timers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private closed = false;
  private cached: Record_ | null = null;

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    core.bus.onAny((name, payload) => {
      if (name === 'turn.started') this.turnStarted(payload as RpcEvents['turn.started']);
      else if (name === 'thread.updated' && (payload as ThreadSummary).archived) this.cancel((payload as ThreadSummary).id, 'the thread was archived');
      else if (name === 'settings.updated' && (payload as Settings).autoResumeLimitedThreads !== true) this.cancelAll('automatic resume was turned off');
    });
  }

  /**
   * Once the journal is open: plans a previous core left are armed again,
   * those of threads that are gone dropped, and one caught while dispatching
   * dropped too, since its turn may already have gone out.
   */
  start(): void {
    const record = this.load();
    let changed = false;
    for (const [threadId, entry] of Object.entries(record)) {
      if (this.core.journal.getThread(threadId) === null) {
        delete record[threadId];
        changed = true;
        continue;
      }
      const plan = entry.plan;
      if (plan === undefined) continue;
      if (plan.dispatching) {
        record[threadId] = { resumedWindow: plan.resetsAt };
        changed = true;
        this.log('warn', threadId, `The usage limit resume of turn ${plan.turnId} was being sent when the previous core stopped; it is not sent again`, 'limit-resume.uncertain', plan);
        continue;
      }
      this.arm(threadId, Math.max(LIMIT_RESUME.startDelayMs, plan.at - Date.now()));
    }
    if (changed) this.save(record);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** The resume planned for the thread, as its row shows it; null when none or while it goes out. */
  retryOf(threadId: ThreadId): ThreadRetry | null {
    const plan = this.load()[threadId]?.plan;
    if (plan === undefined || plan.dispatching) return null;
    return { kind: 'usage-limit', turnId: plan.turnId, at: plan.at, attempt: 1, attempts: 1, resetsAt: plan.resetsAt };
  }

  /**
   * A turn of the thread failed on a spent usage window. `resetsAt` is the
   * reset the agent reported, null when it said none. Nothing waits on it.
   */
  turnFailed(thread: ThreadSummary, turn: Turn, resetsAt: number | null): void {
    if (this.core.settings.get().autoResumeLimitedThreads !== true) return;
    // Sub-threads answer to their parent; a compaction or a wake is not worth repeating.
    if (thread.parentThreadId) return;
    const operation = turn.execution?.operation;
    if (operation !== undefined && operation !== 'resume') return;
    const accountId = turn.execution?.accountId ?? thread.accountId;
    void (async () => {
      const reset = resetsAt ?? await this.spentWindowReset(accountId);
      this.plan(thread.id, turn, reset);
    })().catch(error => this.log('warn', thread.id, `Planning the usage limit resume failed: ${messageOf(error)}`, 'limit-resume.failed'));
  }

  /** Drops the plan of the thread. False when it had none. */
  cancel(threadId: ThreadId, reason: string): boolean {
    const record = this.load();
    const plan = record[threadId]?.plan;
    if (plan === undefined || plan.dispatching) return false;
    this.disarm(threadId);
    record[threadId] = { ...(record[threadId]!.resumedWindow === undefined ? {} : { resumedWindow: record[threadId]!.resumedWindow }) };
    this.save(record);
    this.log('info', threadId, `The usage limit resume of turn ${plan.turnId} is cancelled: ${reason}`, 'limit-resume.cancelled', plan);
    this.announce(threadId);
    return true;
  }

  private cancelAll(reason: string): void {
    if (this.core.journal.isClosed()) return;
    for (const [threadId, entry] of Object.entries(this.load())) if (entry.plan && !entry.plan.dispatching) this.cancel(threadId, reason);
  }

  private plan(threadId: ThreadId, turn: Turn, resetsAt: number | null): void {
    if (this.closed || this.core.journal.isClosed()) return;
    const failedAt = turn.finishedAt ?? Date.now();
    if (resetsAt === null) {
      this.log('info', threadId, `Turn ${turn.id} failed on a usage limit whose reset is unknown; it does not resume by itself`, 'limit-resume.skipped', null, { reason: 'unknown-reset' });
      return;
    }
    // A failure that reports a window already reset would resume at once and fail again: no loop.
    if (resetsAt <= failedAt) {
      this.log('info', threadId, `Turn ${turn.id} failed on a usage limit that reports a window already reset; it does not resume by itself`, 'limit-resume.skipped', null, { reason: 'expired-window' });
      return;
    }
    const record = this.load();
    const resumed = record[threadId]?.resumedWindow;
    if (resumed !== undefined && Math.abs(resumed - resetsAt) < SAME_WINDOW_MS) {
      this.log('info', threadId, `Turn ${turn.id} failed again in the window it already resumed after; it does not resume twice`, 'limit-resume.skipped', null, { reason: 'same-window' });
      return;
    }
    const thread = this.core.journal.getThread(threadId);
    // The user moved on while the reset was read.
    if (thread === null || thread.archived || this.lastTurnId(threadId) !== turn.id) return;
    const plan: Plan = {
      turnId: turn.id, resetsAt, at: resetsAt + LIMIT_RESUME.marginMs,
      providerId: turn.execution?.providerId ?? thread.providerId,
      accountId: turn.execution?.accountId ?? thread.accountId,
      model: turn.execution ? turn.execution.model : thread.model,
      sessionGeneration: thread.sessionGeneration ?? 0,
    };
    record[threadId] = { ...record[threadId], plan };
    this.save(record);
    this.arm(threadId, plan.at - Date.now());
    this.log('info', threadId, `Turn ${turn.id} failed on a usage limit; the thread resumes at ${new Date(plan.at).toISOString()}`, 'limit-resume.planned', plan);
    this.announce(threadId);
  }

  private arm(threadId: ThreadId, delayMs: number): void {
    this.disarm(threadId);
    if (this.closed) return;
    // A timer longer than 2^31 - 1 ms fires at once: a far reset is checked again on the way.
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      const plan = this.load()[threadId]?.plan;
      if (plan && !plan.dispatching && plan.at > Date.now() + 1_000) this.arm(threadId, plan.at - Date.now());
      else this.fire(threadId);
    }, Math.max(0, Math.min(delayMs, 2_000_000_000)));
    timer.unref?.();
    this.timers.set(threadId, timer);
  }

  private disarm(threadId: ThreadId): void {
    const timer = this.timers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(threadId);
  }

  private fire(threadId: ThreadId): void {
    if (this.closed || this.core.stopping || this.core.journal.isClosed()) return;
    const record = this.load();
    const plan = record[threadId]?.plan;
    if (plan === undefined || plan.dispatching) return;
    const refusal = this.refusal(threadId, plan);
    if (refusal !== null) {
      this.cancel(threadId, refusal);
      return;
    }
    record[threadId] = { ...record[threadId], plan: { ...plan, dispatching: true } };
    this.save(record);
    try {
      // The request id makes the resume one turn whatever happens: a second call returns the first.
      const turn = this.threads.startTurn(threadId, { prompt: LIMIT_RESUME_PROMPT, display: LIMIT_RESUME_LABEL }, { kind: 'resume', reason: 'limit', requestId: `limit-resume_${plan.turnId}` });
      this.log('info', threadId, `The usage limit of turn ${plan.turnId} has reset; turn ${turn.id} resumes the thread`, 'limit-resume.started', plan);
    } catch (error) {
      this.log('warn', threadId, `The usage limit resume of turn ${plan.turnId} could not start: ${messageOf(error)}`, 'limit-resume.failed', plan);
    } finally {
      const after = this.load();
      after[threadId] = { resumedWindow: plan.resetsAt };
      this.save(after);
      this.announce(threadId);
    }
  }

  /** Why the plan must not go out now, or null. */
  private refusal(threadId: ThreadId, plan: Plan): string | null {
    if (this.core.settings.get().autoResumeLimitedThreads !== true) return 'automatic resume was turned off';
    const thread = this.core.journal.getThread(threadId);
    if (thread === null) return 'the thread is gone';
    if (thread.archived) return 'the thread was archived';
    if (this.threads.isBusy(threadId)) return 'the thread is busy';
    if (this.lastTurnId(threadId) !== plan.turnId) return 'the thread was answered since';
    if (this.core.journal.getTurn(plan.turnId)?.status !== 'error') return 'the turn is no longer the failed one';
    if (thread.providerId !== plan.providerId || thread.accountId !== plan.accountId || thread.model !== plan.model || (thread.sessionGeneration ?? 0) !== plan.sessionGeneration) {
      return "the thread's provider, account or model changed";
    }
    if (this.threads.cards.listPermissions(threadId).length > 0 || this.threads.cards.listQuestions(threadId).some(question => !question.async)) return 'a card waits for the user';
    if (this.core.delegation.config(threadId).paused) return 'its subagent team is paused';
    return null;
  }

  /** A turn of the user's, or any other, opened on the thread: the resume is no longer the next thing. */
  private turnStarted(turn: Turn): void {
    const plan = this.load()[turn.threadId]?.plan;
    if (plan !== undefined && !plan.dispatching) this.cancel(turn.threadId, 'the thread was answered since');
  }

  /** The reset of the latest spent window of the account's quota, or null when none is spent or none could be read. */
  private async spentWindowReset(accountId: string): Promise<number | null> {
    const quota = await this.core.quotas.readAccount(accountId, true).catch(() => null);
    let latest: number | null = null;
    for (const window of quota?.windows ?? []) {
      if (window.usedPercent < 100 || window.resetsAt === null) continue;
      if (latest === null || window.resetsAt > latest) latest = window.resetsAt;
    }
    return latest;
  }

  private lastTurnId(threadId: ThreadId): TurnId | null {
    const row = this.core.journal.db.query('SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1').get(threadId) as { id: string } | null;
    return row?.id ?? null;
  }

  /** A copy of the record: read from the journal once, then kept, since every thread row asks for it. */
  private load(): Record_ {
    if (this.cached === null) {
      if (this.core.journal.isClosed()) return {};
      const value = this.core.journal.getSetting(KEY);
      this.cached = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record_ : {};
    }
    return { ...this.cached };
  }

  private save(record: Record_): void {
    if (this.core.journal.isClosed()) return;
    for (const [threadId, entry] of Object.entries(record)) if (entry.plan === undefined && entry.resumedWindow === undefined) delete record[threadId];
    if (Object.keys(record).length === 0) this.core.journal.deleteSetting(KEY);
    else this.core.journal.setSetting(KEY, record);
    this.cached = record;
  }

  private announce(threadId: ThreadId): void {
    if (this.core.journal.isClosed()) return;
    const thread = this.core.journal.getThread(threadId);
    if (thread !== null) this.core.bus.emit('thread.updated', withLoad(this.core, thread));
  }

  private log(level: 'info' | 'warn', threadId: ThreadId, message: string, event: string, plan: Plan | null = null, extra: Record<string, string> = {}): void {
    try {
      this.core.logs.record(level, message, {
        source: 'turns', event, threadId, ...(plan ? { turnId: plan.turnId } : {}),
        data: { ...extra, ...(plan ? { resetsAt: plan.resetsAt, at: plan.at, providerId: plan.providerId } : {}) },
      });
    } catch { /* the plan stands without its record */ }
  }
}
