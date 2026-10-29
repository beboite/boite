import type { RpcEvents, ThreadId, ThreadRetry, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';
import { withLoad } from './records.ts';
import { RESUME_TEXT, type PlannedReason } from './resume-text.ts';

/**
 * Mutable so a test can shorten them. `limit`: how long after a window's reset
 * the thread resumes, so the provider has rolled it over, and the least a
 * plan waits after a core start. `carryOn`: how long after a stop the first
 * and the second resume of a row go out, past the last one Boite gives up,
 * and the least a resume waits after a core start.
 */
export const RESUME_TIMING = {
  limit: { marginMs: 60_000, startDelayMs: 2_000 },
  carryOn: { delaysMs: [60_000, 300_000], startDelayMs: 3_000 },
};

/** The journal setting holding every planned resume and each thread's row of resumes. */
const KEY = 'resumes';
/** Where the two planners this one replaced kept theirs: read once, then removed. */
const LEGACY_LIMIT_KEY = 'limit-resumes';
const LEGACY_CARRY_ON_KEY = 'auto-continues';
/** How long a resume waits for a cache ping it stopped to end. */
const PING_YIELD_MS = 1_000;

/** The account, model and session a usage limit was hit on: a resume on another one would not be the same work. */
export interface LimitSelection {
  providerId: string;
  accountId: string;
  model: string | null;
  sessionGeneration: number;
}

export interface Plan {
  reason: PlannedReason;
  /** The turn that stopped: the thread's last turn while the plan stands. */
  turnId: TurnId;
  at: number;
  prompt: string;
  /** A usage limit's: the reset of the spent window, and what it was spent on. */
  resetsAt?: number;
  selection?: LimitSelection;
  /** Written just before the turn is dispatched: a core that finds it so cannot know whether it went out. */
  dispatching?: true;
}

export interface Entry {
  plan?: Plan;
  /** Carry-on resumes sent since the user last wrote or a turn of another kind finished well. */
  streak?: number;
  /** The last turn a plan was made for: a turn is resumed once. */
  handled?: TurnId;
  /** The last carry-on resume sent: its own good end does not reset the row, so background work dying each time cannot loop. */
  resumeTurnId?: TurnId;
  /** The reset of the window this thread last resumed after: one usage limit resume per window. */
  resumedWindow?: number;
}

type Record_ = Record<ThreadId, Entry>;

/**
 * Every resume the core plans for a thread by itself, whatever stopped it: a
 * usage limit (`threads/limit-resume.ts`) or a turn that stopped before its
 * answer (`threads/auto-continue.ts`). One journalled record survives a
 * restart; a plan caught while dispatching is dropped, since its turn may
 * have gone out. Everything is checked again when it fires. A cache ping
 * neither cancels a plan nor holds it back: it gives way.
 */
export class ResumePlanner {
  readonly #timers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  #closed = false;
  #cached: Record_ | null = null;

  readonly #core: Core;

  constructor(core: Core, private readonly threads: ThreadStore) {
    this.#core = core;
    // An archive that rolls back keeps the plan and its timer.
    core.bus.onCommitted((name, payload) => {
      if (this.#closed) return;
      if (name === 'turn.started') this.#turnStarted(payload as RpcEvents['turn.started']);
      else if (name === 'thread.updated' && (payload as ThreadSummary).archived) this.cancel((payload as ThreadSummary).id, 'the thread was archived');
    });
  }

  /** Once recovery ran: plans a previous core left are armed again, those of threads that are gone dropped. */
  start(): void {
    const record = this.#load();
    let changed = false;
    for (const [threadId, entry] of Object.entries(record)) {
      const thread = this.#core.journal.getThread(threadId);
      if (thread === null || (thread.archived && entry.resumedWindow === undefined)) {
        delete record[threadId];
        changed = true;
        continue;
      }
      // An archived thread can come back: the window it resumed after stays, as `forget` keeps it.
      if (thread.archived) {
        if (Object.keys(entry).length > 1) {
          record[threadId] = { resumedWindow: entry.resumedWindow };
          changed = true;
        }
        continue;
      }
      const plan = entry.plan;
      if (plan === undefined) continue;
      if (plan.dispatching) {
        record[threadId] = settled(entry, plan, false);
        changed = true;
        this.log('warn', threadId, `The ${what(plan)} of turn ${plan.turnId} was being sent when the previous core stopped; it is not sent again`, 'uncertain', plan);
        continue;
      }
      const startDelay = plan.reason === 'limit' ? RESUME_TIMING.limit.startDelayMs : RESUME_TIMING.carryOn.startDelayMs;
      this.#arm(threadId, Math.max(startDelay, plan.at - Date.now()));
    }
    if (changed) this.#save(record);
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /** The thread's row of resumes, a copy. */
  entry(threadId: ThreadId): Entry | undefined {
    const entry = this.#load()[threadId];
    return entry === undefined ? undefined : { ...entry };
  }

  /** Whether a resume is planned or going out. */
  planned(threadId: ThreadId): boolean {
    return this.#load()[threadId]?.plan !== undefined;
  }

  /** The resume planned for the thread, as its row shows it; null when none or while it goes out. */
  retryOf(threadId: ThreadId): ThreadRetry | null {
    const entry = this.#load()[threadId];
    const plan = entry?.plan;
    if (plan === undefined || plan.dispatching) return null;
    if (plan.reason === 'limit') return { kind: 'usage-limit', turnId: plan.turnId, at: plan.at, attempt: 1, attempts: 1, resetsAt: plan.resetsAt ?? null };
    return { kind: 'auto-continue', turnId: plan.turnId, at: plan.at, attempt: (entry!.streak ?? 0) + 1, attempts: RESUME_TIMING.carryOn.delaysMs.length, resetsAt: null };
  }

  /** Plans the resume of `turn`, the thread's last, at `plan.at`. The caller decided it is due. */
  schedule(threadId: ThreadId, turn: Turn, plan: Omit<Plan, 'turnId' | 'dispatching'>, message: string): void {
    if (this.#closed || this.#core.journal.isClosed()) return;
    const full: Plan = { ...plan, turnId: turn.id };
    const record = this.#load();
    record[threadId] = { ...record[threadId], handled: turn.id, plan: full };
    this.#save(record);
    this.#arm(threadId, full.at - Date.now());
    this.log('info', threadId, message, 'planned', full);
    this.#announce(threadId);
  }

  /** Writes the thread's row with no plan: a turn resumes nothing more. */
  settle(threadId: ThreadId, entry: Omit<Entry, 'plan'>): void {
    if (this.#core.journal.isClosed()) return;
    const record = this.#load();
    record[threadId] = entry;
    this.#save(record);
  }

  /** Drops the plan of the thread, when `which` accepts it. False when it had none. */
  cancel(threadId: ThreadId, reason: string, which: (plan: Plan) => boolean = () => true): boolean {
    const record = this.#load();
    const entry = record[threadId];
    const plan = entry?.plan;
    if (entry === undefined || plan === undefined || plan.dispatching || !which(plan)) return false;
    this.#disarm(threadId);
    const { plan: _, ...rest } = entry;
    record[threadId] = { ...rest, handled: plan.turnId };
    this.#save(record);
    this.log('info', threadId, `The ${what(plan)} of turn ${plan.turnId} is cancelled: ${reason}`, 'cancelled', plan);
    this.#announce(threadId);
    return true;
  }

  cancelAll(reason: string, which: (plan: Plan) => boolean): void {
    if (this.#core.journal.isClosed()) return;
    for (const threadId of Object.keys(this.#load())) this.cancel(threadId, reason, which);
  }

  /**
   * The row of carry-on resumes ends: the thread is back in the user's hands
   * or answered well. The usage window it resumed after stays, so a limit
   * never turns into a loop.
   */
  forget(threadId: ThreadId): void {
    const record = this.#load();
    const entry = record[threadId];
    if (entry === undefined || entry.plan?.dispatching) return;
    if (entry.plan !== undefined) this.#disarm(threadId);
    if (entry.resumedWindow === undefined) delete record[threadId];
    else record[threadId] = { resumedWindow: entry.resumedWindow };
    this.#save(record);
    if (entry.plan !== undefined) this.#announce(threadId);
  }

  /** The thread's latest turn that is not a cache ping. */
  lastTurn(threadId: ThreadId): Turn | null {
    const rows = this.#core.journal.db.query('SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 50').all(threadId) as { id: string }[];
    for (const row of rows) {
      const turn = this.#core.journal.getTurn(row.id);
      if (turn !== null && turn.execution?.operation !== 'keepalive') return turn;
    }
    return null;
  }

  log(level: 'info' | 'warn', threadId: ThreadId, message: string, event: string, plan: Plan | null = null, extra: Record<string, string> = {}, reason: PlannedReason | undefined = plan?.reason): void {
    try {
      this.#core.logs.record(level, message, {
        source: 'turns', event: `${reason === 'limit' ? 'limit-resume' : 'auto-continue'}.${event}`, threadId, ...(plan ? { turnId: plan.turnId } : {}),
        data: { ...extra, ...(plan ? { reason: plan.reason, at: plan.at, ...(plan.resetsAt !== undefined ? { resetsAt: plan.resetsAt } : {}), ...(plan.selection ? { providerId: plan.selection.providerId } : {}) } : {}) },
      });
    } catch { /* the plan stands without its record */ }
  }

  #arm(threadId: ThreadId, delayMs: number): void {
    this.#disarm(threadId);
    if (this.#closed) return;
    // A timer longer than 2^31 - 1 ms fires at once: a far plan is checked again on the way.
    const timer = setTimeout(() => {
      this.#timers.delete(threadId);
      this.#fire(threadId);
    }, Math.max(0, Math.min(delayMs, 2_000_000_000)));
    timer.unref?.();
    this.#timers.set(threadId, timer);
  }

  #disarm(threadId: ThreadId): void {
    const timer = this.#timers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(threadId);
  }

  #fire(threadId: ThreadId): void {
    if (this.#closed || this.#core.stopping || this.#core.journal.isClosed()) return;
    const record = this.#load();
    const entry = record[threadId];
    const plan = entry?.plan;
    if (entry === undefined || plan === undefined || plan.dispatching) return;
    if (plan.at > Date.now() + 1_000) { this.#arm(threadId, plan.at - Date.now()); return; }
    // A cache ping holds the thread only to keep it warm: it gives way, and the resume goes once it stopped.
    if (this.threads.cacheKeepalive.yieldTo(threadId)) { this.#arm(threadId, PING_YIELD_MS); return; }
    const refusal = this.#refusal(threadId, plan);
    if (refusal !== null) { this.cancel(threadId, refusal); return; }
    record[threadId] = { ...entry, plan: { ...plan, dispatching: true } };
    this.#save(record);
    let sent: TurnId | null = null;
    try {
      // The request id makes the resume one turn whatever happens: a second call returns the first.
      const limit = plan.reason === 'limit';
      const turn = this.threads.startTurn(threadId, { prompt: plan.prompt, display: RESUME_TEXT[plan.reason].label },
        { kind: 'resume', reason: limit ? 'limit' : 'carry-on', requestId: `${limit ? 'limit-resume' : 'auto-continue'}_${plan.turnId}` });
      sent = turn.id;
      this.log('info', threadId, `Turn ${turn.id} resumes the thread after turn ${plan.turnId} stopped (${plan.reason})`, 'started', plan);
    } catch (error) {
      this.log('warn', threadId, `The ${what(plan)} of turn ${plan.turnId} could not start: ${messageOf(error)}`, 'failed', plan);
    } finally {
      const after = this.#load();
      after[threadId] = settled(after[threadId] ?? entry, plan, sent);
      this.#save(after);
      this.#announce(threadId);
    }
  }

  /** Why the plan must not go out now, or null. */
  #refusal(threadId: ThreadId, plan: Plan): string | null {
    const limit = plan.reason === 'limit';
    if (limit && this.#core.settings.get().autoResumeLimitedThreads !== true) return 'automatic resume was turned off';
    const thread = this.#core.journal.getThread(threadId);
    if (thread === null) return 'the thread is gone';
    if (thread.archived) return 'the thread was archived';
    if (this.threads.isBusy(threadId)) return 'the thread is busy';
    if (this.lastTurn(threadId)?.id !== plan.turnId) return 'the thread was answered since';
    if (limit && this.#core.journal.getTurn(plan.turnId)?.status !== 'error') return 'the turn is no longer the failed one';
    const selection = plan.selection;
    if (selection && (thread.providerId !== selection.providerId || thread.accountId !== selection.accountId || thread.model !== selection.model || (thread.sessionGeneration ?? 0) !== selection.sessionGeneration)) {
      return "the thread's provider, account or model changed";
    }
    if (this.threads.cards.listPermissions(threadId).length > 0 || this.threads.cards.listQuestions(threadId).some(question => !question.async)) return 'a card waits for the user';
    const team = this.#core.delegation.config(threadId);
    // A team the user paused or stopped is his to restart; one a crash held is the agent's to resume.
    if (team.paused && (team.pausedBy === undefined || team.pausedBy === 'owner' || team.pausedBy === 'stop')) return 'the user paused its subagent team';
    return null;
  }

  /** A turn of the user's, or any other, opened on the thread: the resume is no longer the next thing. */
  #turnStarted(turn: Turn): void {
    // A cache ping answers nothing (`cache-keepalive.ts`).
    if (turn.execution?.operation === 'keepalive') return;
    const entry = this.#load()[turn.threadId];
    if (entry === undefined) return;
    if (entry.plan !== undefined && !entry.plan.dispatching) this.cancel(turn.threadId, 'the thread was answered since');
    // The user's own words end the row: whatever stops next is a new problem.
    if (turn.execution?.operation === undefined) this.forget(turn.threadId);
  }

  /** A copy of the record: read from the journal once, then kept, since every thread row asks for it. */
  #load(): Record_ {
    if (this.#cached === null) {
      if (this.#core.journal.isClosed()) return {};
      this.#cached = this.#read();
    }
    return { ...this.#cached };
  }

  /** The record, with the two legacy records merged into it once and removed. */
  #read(): Record_ {
    const journal = this.#core.journal;
    const own = asRecord(journal.getSetting(KEY));
    const limits = asRecord(journal.getSetting(LEGACY_LIMIT_KEY));
    const carryOns = asRecord(journal.getSetting(LEGACY_CARRY_ON_KEY));
    if (Object.keys(limits).length === 0 && Object.keys(carryOns).length === 0) return own;
    const merged: Record_ = { ...own };
    for (const [threadId, legacy] of Object.entries(carryOns) as [ThreadId, Entry & { plan?: Plan & { reason: PlannedReason } }][]) {
      merged[threadId] = { ...legacy, ...merged[threadId] };
    }
    for (const [threadId, legacy] of Object.entries(limits) as [ThreadId, LegacyLimitEntry][]) {
      const entry: Entry = { ...merged[threadId], ...(legacy.resumedWindow !== undefined ? { resumedWindow: legacy.resumedWindow } : {}) };
      const old = legacy.plan;
      if (old !== undefined && entry.plan === undefined) {
        entry.plan = {
          reason: 'limit', turnId: old.turnId, at: old.at, prompt: RESUME_TEXT.limit.prompt, resetsAt: old.resetsAt,
          selection: { providerId: old.providerId, accountId: old.accountId, model: old.model, sessionGeneration: old.sessionGeneration },
          ...(old.dispatching ? { dispatching: true as const } : {}),
        };
      }
      merged[threadId] = entry;
    }
    journal.db.transaction(() => {
      if (Object.keys(merged).length === 0) journal.deleteSetting(KEY);
      else journal.setSetting(KEY, merged);
      journal.deleteSetting(LEGACY_LIMIT_KEY);
      journal.deleteSetting(LEGACY_CARRY_ON_KEY);
    })();
    return merged;
  }

  #save(record: Record_): void {
    if (this.#core.journal.isClosed()) return;
    for (const [threadId, entry] of Object.entries(record)) if (Object.values(entry).every(value => value === undefined)) delete record[threadId];
    if (Object.keys(record).length === 0) this.#core.journal.deleteSetting(KEY);
    else this.#core.journal.setSetting(KEY, record);
    this.#cached = record;
  }

  #announce(threadId: ThreadId): void {
    if (this.#core.journal.isClosed()) return;
    const thread = this.#core.journal.getThread(threadId);
    if (thread !== null) this.#core.bus.emit('thread.updated', withLoad(this.#core, thread));
  }
}

interface LegacyLimitEntry {
  plan?: { turnId: TurnId; resetsAt: number; at: number; providerId: string; accountId: string; model: string | null; sessionGeneration: number; dispatching?: true };
  resumedWindow?: number;
}

function asRecord(value: unknown): Record_ {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record_ : {};
}

function what(plan: Plan): string {
  return plan.reason === 'limit' ? 'usage limit resume' : 'automatic resume';
}

/**
 * The row once `plan` went out, failed to or may have: the turn is handled, a
 * usage limit's window is spent, and a carry-on resume `sent` counts in the
 * row of resumes.
 */
function settled(entry: Entry, plan: Plan, sent: TurnId | null | false): Entry {
  const { plan: _, ...rest } = entry;
  if (plan.reason === 'limit') return { ...rest, handled: plan.turnId, ...(plan.resetsAt !== undefined ? { resumedWindow: plan.resetsAt } : {}) };
  return { ...rest, handled: plan.turnId, streak: (rest.streak ?? 0) + (sent ? 1 : 0), ...(sent ? { resumeTurnId: sent } : {}) };
}
