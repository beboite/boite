import type { BackgroundWait, RpcEvents, ThreadId, ThreadRetry, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { INTERRUPTION_TEXT } from '../delegation/interruption.ts';
import type { TurnResult } from '../drivers/types.ts';
import { messageOf } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';
import { HANDOFF } from './handoff.ts';
import { backgroundWaitOf, withLoad } from './records.ts';

/**
 * `delaysMs`: how long after a stop the first and the second resume of a row
 * go out; past the last one Boite gives up and the failure stays for the user.
 * `startDelayMs`: the least a resume waits after a core start, so the start
 * finishes first. Mutable so a test can shorten them.
 */
export const AUTO_CONTINUE = { delaysMs: [60_000, 300_000], startDelayMs: 3_000 };

/** Why a turn stopped before its answer, and so what its resume tells the agent. */
export type StopReason = 'error' | 'crash' | 'compaction' | 'background';

const CRASH_PROMPT = 'Boite stopped unexpectedly while your previous turn was running (a crash or a forced quit) and has started again. The conversation and the files are as you left them. A command that was running at that moment may have been cut short: check its result before relying on it. Continue the work from where you stopped, without starting over.';
const CARRY_ON = 'The conversation and the files are as you left them. Continue the current task from where it stopped, without repeating completed work. If the task was already complete, give your final answer.';

/** How the resumed turn's opening reads in the conversation. */
export const AUTO_CONTINUE_LABEL: Record<StopReason, string> = {
  error: 'Resumed after an error',
  crash: 'Resumed after a crash',
  compaction: 'Resumed after a compaction',
  background: 'Resumed after background work was interrupted',
};

/** The journal setting holding every planned resume and each thread's row of resumes. */
const KEY = 'auto-continues';
/** Left by a core the owner stopped on purpose: the next one resumes nothing it cut. */
const STOPPED_KEY = 'auto-continue-stopped';
/** An error is quoted to the agent up to this many characters. */
const ERROR_QUOTE = 600;
/** How long a resume waits for a cache ping it stopped to end. */
const PING_YIELD_MS = 1_000;

interface Plan {
  reason: StopReason;
  /** The turn that stopped before its answer: the thread's last turn while the plan stands. */
  turnId: TurnId;
  at: number;
  prompt: string;
  /** Written just before the turn is dispatched: a core that finds it so cannot know whether it went out. */
  dispatching?: true;
}

interface Entry {
  plan?: Plan;
  /** Resumes sent since the user last wrote or a turn of another kind finished well. */
  streak: number;
  /** The last turn a plan was made for: background work that ended once is resumed once. */
  handled?: TurnId;
  /** The last resume sent: its own good end does not reset the row, so background work dying each time cannot loop. */
  resumeTurnId?: TurnId;
}

type Record_ = Record<ThreadId, Entry>;

/**
 * Turns that stop before the agent gave its answer resume by themselves: an
 * error from the agent or its API, a core that died under the turn, a turn
 * that ended right after a compaction, and background work the agent waited
 * on that ended without waking it, the last two whether a restart caused them
 * or not. Each plan is journalled and checked again when it fires: a thread
 * the user wrote in, stopped, archived or moved to another turn cancels it.
 * Two resumes in a row that stop again end the row; the last failure stays on
 * the thread and notifies like any other. Usage limits belong to
 * `limit-resume.ts`, a restart handoff to `handoff.ts`, and a stop to the user.
 */
export class AutoContinues {
  private readonly timers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  /** When top-level threads waiting on background work wake up or count as interrupted. */
  private readonly watches = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  /** Turns the previous core left running that recovery closed for a resume, armed by `start`. */
  private readonly crashed: Turn[] = [];
  private closed = false;
  private started = false;
  private cached: Record_ | null = null;
  private cut: boolean | undefined;
  private heldRuns: Set<string> | undefined;
  private heldTeams: Set<string> | undefined;

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    // An archive that rolls back keeps the planned resume and its timer.
    core.bus.onCommitted((name, payload) => {
      if (this.closed) return;
      if (name === 'turn.started') this.turnStarted(payload as RpcEvents['turn.started']);
      else if (name === 'thread.updated' && (payload as ThreadSummary).archived) this.cancel((payload as ThreadSummary).id, 'the thread was archived');
    });
    core.bus.onCommitted((name, payload) => {
      if (!this.closed && this.started && name === 'thread.background') this.watchBackground((payload as RpcEvents['thread.background']).threadId);
    });
  }

  /**
   * Whether the previous core died under its work rather than being stopped
   * on purpose, recently enough for that work to go on: within the hour a
   * restart handoff keeps, counted from its last thread event. Read before
   * this core writes any, so call it before recovery.
   */
  previousRunCut(): boolean {
    if (this.cut === undefined) {
      const row = this.core.journal.db.query("SELECT ts FROM events WHERE thread_id IS NOT NULL AND type != 'thread.background.interrupted' ORDER BY id DESC LIMIT 1").get() as { ts: number } | null;
      this.cut = this.core.journal.getSetting(STOPPED_KEY) == null && row !== null && Date.now() - row.ts <= HANDOFF.maxAgeMs;
    }
    return this.cut;
  }

  /**
   * The owner stops this core without a handoff (`core.shutdown`, `SIGINT`,
   * `POST /shutdown`): what it cuts is his decision, not a crash.
   */
  noteDeliberateStop(): void {
    if (!this.core.journal.isClosed()) this.core.journal.setSetting(STOPPED_KEY, Date.now());
  }

  /** Whether a turn the previous core left running resumes once this one starts. Recovery closes it either way. */
  resumesCrashed(turn: Turn): boolean {
    const thread = this.core.journal.getThread(turn.threadId);
    if (thread === null || !this.eligible(thread, turn) || !this.previousRunCut()) return false;
    // As `plan` decides: a turn already resumed, or a row out of resumes, gets none.
    const entry = this.load()[turn.threadId];
    if (entry !== undefined && (entry.handled === turn.id || entry.streak >= AUTO_CONTINUE.delaysMs.length)) return false;
    this.crashed.push(turn);
    return true;
  }

  /**
   * Once recovery ran: plans a previous core left are armed again (one caught
   * while dispatching is dropped, since its turn may have gone out), then the
   * turns it left running, then the threads whose background work, team or
   * workflow runs it cut with no turn running.
   */
  start(interrupted: Iterable<ThreadId> = []): void {
    try { this.startPlans(interrupted); }
    // What the crash held is news only to the prompts of this start: a later one must not repeat it.
    finally { this.heldTeams = new Set(); this.heldRuns = new Set(); }
  }

  private startPlans(interrupted: Iterable<ThreadId>): void {
    this.started = true;
    const cut = this.previousRunCut();
    this.core.journal.deleteSetting(STOPPED_KEY);
    const record = this.load();
    let changed = false;
    for (const [threadId, entry] of Object.entries(record)) {
      const thread = this.core.journal.getThread(threadId);
      if (thread === null || thread.archived) {
        delete record[threadId];
        changed = true;
        continue;
      }
      const plan = entry.plan;
      if (plan === undefined) continue;
      if (plan.dispatching) {
        record[threadId] = { streak: entry.streak, handled: plan.turnId, ...(entry.resumeTurnId ? { resumeTurnId: entry.resumeTurnId } : {}) };
        changed = true;
        this.log('warn', threadId, `The automatic resume of turn ${plan.turnId} was being sent when the previous core stopped; it is not sent again`, 'auto-continue.uncertain', plan);
        continue;
      }
      this.arm(threadId, Math.max(AUTO_CONTINUE.startDelayMs, plan.at - Date.now()));
    }
    if (changed) this.save(record);
    const resumed = new Set<ThreadId>();
    for (const turn of this.crashed.splice(0)) {
      if (this.planned(turn.threadId)) continue;
      const prompt = this.withHeldWork(turn.threadId, this.threads.handoff.continuation(turn, CRASH_PROMPT));
      if (this.plan(turn.threadId, turn, 'crash', prompt, AUTO_CONTINUE.startDelayMs)) resumed.add(turn.threadId);
    }
    if (!cut) return;
    const held = new Set([...interrupted, ...this.teamsHeldByRestart(), ...this.runsHeldByRestart()]);
    for (const threadId of held) {
      if (resumed.has(threadId) || this.planned(threadId)) continue;
      const thread = this.core.journal.getThread(threadId);
      const turn = thread ? this.lastTurn(threadId) : null;
      // A team or a run can wait on a parent whose own turn was answered or failed: the restart still cut it.
      // One the user stopped stays stopped.
      if (thread === null || turn === null || turn.status === 'stopped' || !this.eligible(thread, turn)) continue;
      const wait = turn.status === 'done' ? this.interruptedWait(thread) : null;
      const cut = wait ? this.backgroundPrompt(wait) : null;
      const prompt = this.withHeldWork(threadId, cut ?? '', cut === null);
      if (prompt.length > 0) this.plan(threadId, turn, 'background', prompt, AUTO_CONTINUE.startDelayMs);
    }
  }

  close(): void {
    this.closed = true;
    for (const timer of [...this.timers.values(), ...this.watches.values()]) clearTimeout(timer);
    this.timers.clear();
    this.watches.clear();
  }

  /** The resume planned for the thread, as its row shows it; null when none or while it goes out. */
  retryOf(threadId: ThreadId): ThreadRetry | null {
    const entry = this.load()[threadId];
    const plan = entry?.plan;
    if (plan === undefined || plan.dispatching) return null;
    return { kind: 'auto-continue', turnId: plan.turnId, at: plan.at, attempt: entry!.streak + 1, attempts: AUTO_CONTINUE.delaysMs.length, resetsAt: null };
  }

  /**
   * A turn of the thread ended, its thread saved. An error or a turn that
   * ended on a compaction plans a resume; a turn answered well, or stopped,
   * ends the row of resumes.
   */
  turnFinished(thread: ThreadSummary, turn: Turn, result: TurnResult): void {
    if (this.closed || this.core.stopping || !this.eligible(thread, turn)) return;
    if (turn.status === 'stopped') {
      this.forget(thread.id);
      return;
    }
    if (turn.status === 'done') {
      if (this.endsOnCompaction(turn)) {
        this.plan(thread.id, turn, 'compaction', `Your previous turn ended right after the context was compacted, before its answer. ${CARRY_ON}`);
        return;
      }
      if (this.load()[thread.id]?.resumeTurnId !== turn.id) this.forget(thread.id);
      // Background work it started may still end without waking it.
      this.watchBackground(thread.id);
      return;
    }
    // A refusal has its own retry: a spent usage window resumes at its reset or
    // not at all (`limit-resume.ts`), capacity got its tries in the turn, and a
    // capacity wait the user cancelled must stay failed.
    if (result.refusal) return;
    const error = (turn.error ?? result.error ?? 'unknown error').trim();
    const quoted = error.length > ERROR_QUOTE ? `${error.slice(0, ERROR_QUOTE)} [cut]` : error;
    this.plan(thread.id, turn, 'error', `Your previous turn ended on an error before it finished: ${quoted}\n\nBoite resumed the thread by itself. ${CARRY_ON}`);
  }

  /** Drops the plan of the thread. False when it had none. */
  cancel(threadId: ThreadId, reason: string): boolean {
    const record = this.load();
    const entry = record[threadId];
    const plan = entry?.plan;
    if (entry === undefined || plan === undefined || plan.dispatching) return false;
    this.disarm(threadId);
    record[threadId] = { streak: entry.streak, handled: plan.turnId, ...(entry.resumeTurnId ? { resumeTurnId: entry.resumeTurnId } : {}) };
    this.save(record);
    this.log('info', threadId, `The automatic resume of turn ${plan.turnId} is cancelled: ${reason}`, 'auto-continue.cancelled', plan);
    this.announce(threadId);
    return true;
  }

  /**
   * Background work an agent update ended with the agent's process: the
   * thread resumes like work that ended without waking it, which a session
   * ended on purpose otherwise does not (`watchBackground`). False when it
   * is not the user's own conversation or a resume is already planned.
   */
  resumeCut(threadId: ThreadId, prompt: string): boolean {
    const thread = this.core.journal.getThread(threadId);
    const turn = this.lastTurn(threadId);
    if (thread === null || turn === null || !this.eligible(thread, turn) || this.planned(threadId)) return false;
    return this.plan(threadId, turn, 'background', this.withHeldWork(threadId, prompt));
  }

  /**
   * Conversations of the user's, a persistent agent's among them: a delegated
   * agent answers its parent, which hears of its failure. A compaction, a
   * coordination wake or a cache ping is not worth repeating.
   */
  private eligible(thread: ThreadSummary, turn: Turn): boolean {
    if (thread.archived || thread.parentThreadId) return false;
    const operation = turn.execution?.operation;
    return operation !== 'compact' && operation !== 'coordination' && operation !== 'keepalive';
  }

  /**
   * Plans the thread's next resume, or ends its row: past the last delay, the
   * stop the resumes could not get past stays for the user. False when nothing
   * was planned.
   */
  private plan(threadId: ThreadId, turn: Turn, reason: StopReason, prompt: string, delayMs?: number): boolean {
    if (this.closed || this.core.journal.isClosed()) return false;
    const record = this.load();
    const entry = record[threadId] ?? { streak: 0 };
    if (entry.handled === turn.id) return false;
    if (entry.streak >= AUTO_CONTINUE.delaysMs.length) {
      record[threadId] = { streak: 0, handled: turn.id };
      this.save(record);
      this.log('warn', threadId, `Turn ${turn.id} stopped again after ${entry.streak} automatic resumes in a row; Boite leaves it to the user`, 'auto-continue.gave-up', null, { reason });
      return false;
    }
    const plan: Plan = { reason, turnId: turn.id, at: Date.now() + (delayMs ?? AUTO_CONTINUE.delaysMs[entry.streak]!), prompt };
    record[threadId] = { ...entry, handled: turn.id, plan };
    this.save(record);
    this.arm(threadId, plan.at - Date.now());
    this.log('info', threadId, `Turn ${turn.id} stopped before its answer (${reason}); the thread resumes at ${new Date(plan.at).toISOString()}, resume ${entry.streak + 1} of ${AUTO_CONTINUE.delaysMs.length}`, 'auto-continue.planned', plan);
    this.announce(threadId);
    return true;
  }

  private planned(threadId: ThreadId): boolean {
    return this.load()[threadId]?.plan !== undefined;
  }

  /** The row of resumes ends: the thread is back in the user's hands or answered well. */
  private forget(threadId: ThreadId): void {
    const record = this.load();
    const entry = record[threadId];
    if (entry === undefined) return;
    if (entry.plan !== undefined && !entry.plan.dispatching) this.disarm(threadId);
    if (entry.plan?.dispatching) return;
    delete record[threadId];
    this.save(record);
    if (entry.plan !== undefined) this.announce(threadId);
  }

  private arm(threadId: ThreadId, delayMs: number): void {
    this.disarm(threadId);
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      this.fire(threadId);
    }, Math.max(0, delayMs));
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
    const entry = record[threadId];
    const plan = entry?.plan;
    if (entry === undefined || plan === undefined || plan.dispatching) return;
    // A cache ping holds the thread only to keep it warm: it gives way, and the resume goes once it stopped.
    if (this.threads.cacheKeepalive.yieldTo(threadId)) {
      this.arm(threadId, PING_YIELD_MS);
      return;
    }
    const refusal = this.refusal(threadId, plan);
    if (refusal !== null) {
      this.cancel(threadId, refusal);
      return;
    }
    record[threadId] = { ...entry, plan: { ...plan, dispatching: true } };
    this.save(record);
    let sent = false;
    let resumeTurnId: TurnId | null = null;
    try {
      // The request id makes the resume one turn whatever happens: a second call returns the first.
      const turn = this.threads.startTurn(threadId, plan.prompt, [], undefined, 'resume', undefined, `auto-continue_${plan.turnId}`, AUTO_CONTINUE_LABEL[plan.reason]);
      sent = true;
      resumeTurnId = turn.id;
      this.log('info', threadId, `Turn ${turn.id} resumes the thread after turn ${plan.turnId} stopped (${plan.reason})`, 'auto-continue.started', plan);
    } catch (error) {
      this.log('warn', threadId, `The automatic resume of turn ${plan.turnId} could not start: ${messageOf(error)}`, 'auto-continue.failed', plan);
    } finally {
      const after = this.load();
      after[threadId] = { streak: entry.streak + (sent ? 1 : 0), handled: plan.turnId, ...(resumeTurnId ? { resumeTurnId } : {}) };
      this.save(after);
      this.announce(threadId);
    }
  }

  /** Why the plan must not go out now, or null. */
  private refusal(threadId: ThreadId, plan: Plan): string | null {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null) return 'the thread is gone';
    if (thread.archived) return 'the thread was archived';
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.threads.runner.handles.has(threadId)) return 'the thread is busy';
    if (this.lastTurn(threadId)?.id !== plan.turnId) return 'the thread was answered since';
    if (this.threads.cards.listPermissions(threadId).length > 0 || this.threads.cards.listQuestions(threadId).some(question => !question.async)) return 'a card waits for the user';
    const team = this.core.delegation.config(threadId);
    // A team the user paused or stopped is his to restart; one a crash held is the agent's to resume.
    if (team.paused && (team.pausedBy === undefined || team.pausedBy === 'owner' || team.pausedBy === 'stop')) return 'the user paused its subagent team';
    return null;
  }

  /** A turn of the user's, or any other, opened on the thread: the resume is no longer the next thing. */
  private turnStarted(turn: Turn): void {
    // A cache ping answers nothing (`cache-keepalive.ts`).
    if (turn.execution?.operation === 'keepalive') return;
    const entry = this.load()[turn.threadId];
    if (entry === undefined) return;
    if (entry.plan !== undefined && !entry.plan.dispatching) this.cancel(turn.threadId, 'the thread was answered since');
    // The user's own words end the row: whatever stops next is a new problem.
    if (turn.execution?.operation === undefined) this.forget(turn.threadId);
  }

  /** The turn's answer is a compaction and nothing after it: the agent never came back from it. */
  private endsOnCompaction(turn: Turn): boolean {
    // Newest first, and only as far as the last part that is not thinking.
    for (const message of this.core.journal.walkAgentMessagesBackwards(turn.threadId, turn.id)) {
      const last = message.parts.filter(part => part.type !== 'thinking').at(-1);
      if (last !== undefined) return last.type === 'compaction';
    }
    return false;
  }

  /**
   * A top-level thread at rest whose agent waits on background work: once that
   * work ends without waking it (a failed task, a process that died, a
   * restart), the thread resumes. A Stop or an archive that ended the agent is
   * the user's doing and resumes nothing.
   */
  private watchBackground(threadId: ThreadId): void {
    const watch = this.watches.get(threadId);
    if (watch !== undefined) clearTimeout(watch);
    this.watches.delete(threadId);
    if (this.closed || this.core.stopping || this.core.journal.isClosed()) return;
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived || thread.parentThreadId) return;
    const live = this.threads.agentState.background.get(threadId) ?? [];
    const wait = backgroundWaitOf(this.core, thread, live);
    if (wait?.state === 'waiting' && wait.until !== null) {
      const timer = setTimeout(() => this.watchBackground(threadId), Math.max(0, wait.until - Date.now()) + 50);
      timer.unref?.();
      this.watches.set(threadId, timer);
      return;
    }
    if (wait?.state !== 'interrupted' || wait.reason === 'session-ended') return;
    const turn = this.lastTurn(threadId);
    if (turn === null || !this.eligible(thread, turn) || this.planned(threadId)) return;
    this.plan(threadId, turn, 'background', this.withHeldWork(threadId, this.backgroundPrompt(wait)));
  }

  private interruptedWait(thread: ThreadSummary): Extract<BackgroundWait, { state: 'interrupted' }> | null {
    const wait = backgroundWaitOf(this.core, thread, this.threads.agentState.background.get(thread.id) ?? []);
    return wait?.state === 'interrupted' && wait.reason !== 'session-ended' ? wait : null;
  }

  private backgroundPrompt(wait: Extract<BackgroundWait, { state: 'interrupted' }>): string {
    return `Background work you started (${wait.for}) ended without waking you: ${INTERRUPTION_TEXT[wait.reason]}. Check its result and start again what did not finish. ${CARRY_ON}`;
  }

  /**
   * What a crash paused besides the turn: the subagent team and the workflow
   * runs, which wait for the agent to resume them. `alone` words it as the
   * whole prompt; an empty string when nothing was held.
   */
  private withHeldWork(threadId: ThreadId, prompt: string, alone = false): string {
    const held: string[] = [];
    if (this.teamsHeldByRestart().has(threadId)) held.push('your subagent team');
    if (this.runsHeldByRestart().has(threadId)) held.push('your workflow runs');
    if (held.length === 0) return prompt;
    const note = `Boite stopped unexpectedly and has started again; it paused ${held.join(' and ')} meanwhile. Run \`boite delegate resume\` to let them go on once you checked where they stand.`;
    return alone ? `${note} ${CARRY_ON}` : `${prompt}\n\n${note}`;
  }

  /** Conversations whose subagent team this core paused at its start because the previous one died (`delegation.ts`). */
  private teamsHeldByRestart(): Set<string> {
    this.heldTeams ??= new Set((this.core.journal.db.query("SELECT key FROM settings WHERE key LIKE 'delegation:%'").all() as { key: string }[])
      .map(row => row.key.slice('delegation:'.length))
      .filter(rootId => {
        const config = this.core.delegation.config(rootId);
        return config.paused && config.pausedBy === 'restart' && (config.pausedAt ?? 0) >= this.core.startedAt;
      }));
    return this.heldTeams;
  }

  /** Conversations whose workflow runs this core paused at its start because the previous one died (`workflows.ts`). */
  private runsHeldByRestart(): Set<string> {
    this.heldRuns ??= new Set((this.core.journal.db.query(
      "SELECT root_id FROM workflow_runs WHERE status = 'paused' AND json_extract(data, '$.pausedBy') = 'restart' AND json_extract(data, '$.pausedAt') >= ?",
    ).all(this.core.startedAt) as { root_id: string }[]).map(row => row.root_id));
    return this.heldRuns;
  }

  /** The thread's latest turn that is not a cache ping. */
  private lastTurn(threadId: ThreadId): Turn | null {
    const rows = this.core.journal.db.query('SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 50').all(threadId) as { id: string }[];
    for (const row of rows) {
      const turn = this.core.journal.getTurn(row.id);
      if (turn !== null && turn.execution?.operation !== 'keepalive') return turn;
    }
    return null;
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
        data: { ...extra, ...(plan ? { reason: plan.reason, at: plan.at } : {}) },
      });
    } catch { /* the plan stands without its record */ }
  }
}
