import type { BackgroundWait, RpcEvents, ThreadId, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { INTERRUPTION_TEXT } from '../delegation/interruption.ts';
import type { TurnResult } from '../drivers/types.ts';
import type { ThreadStore } from '../threads.ts';
import { HANDOFF } from './handoff.ts';
import { backgroundWaitOf } from './records.ts';
import { CARRY_ON, RESUME_TEXT, type PlannedReason } from './resume-text.ts';
import { RESUME_TIMING, type ResumePlanner } from './resume.ts';

/** Mutable so a test can shorten them (`threads/resume.ts`). */
export const AUTO_CONTINUE = RESUME_TIMING.carryOn;

/** Why a turn stopped before its answer, and so what its resume tells the agent. */
export type StopReason = Exclude<PlannedReason, 'limit'>;

/** How the resumed turn's opening reads in the conversation. */
export const AUTO_CONTINUE_LABEL: Record<StopReason, string> = {
  error: RESUME_TEXT.error.label,
  crash: RESUME_TEXT.crash.label,
  compaction: RESUME_TEXT.compaction.label,
  background: RESUME_TEXT.background.label,
};

/** Left by a core the owner stopped on purpose: the next one resumes nothing it cut. */
const STOPPED_KEY = 'auto-continue-stopped';
/** An error is quoted to the agent up to this many characters. */
const ERROR_QUOTE = 600;

/**
 * Turns that stop before the agent gave its answer resume by themselves: an
 * error from the agent or its API, a core that died under the turn, a turn
 * that ended right after a compaction, and background work the agent waited
 * on that ended without waking it, the last two whether a restart caused them
 * or not. `ResumePlanner` journals each plan and checks it again when it
 * fires: a thread the user wrote in, stopped, archived or moved to another
 * turn cancels it. Two resumes in a row that stop again end the row; the last
 * failure stays on the thread and notifies like any other. Usage limits
 * belong to `limit-resume.ts`, a restart handoff to `handoff.ts`, and a stop
 * to the user.
 */
export class AutoContinues {
  /** When top-level threads waiting on background work wake up or count as interrupted. */
  readonly #watches = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  /** Turns the previous core left running that recovery closed for a resume, armed by `start`. */
  readonly #crashed: Turn[] = [];
  #closed = false;
  #started = false;
  #cut: boolean | undefined;
  #heldRuns: Set<string> | undefined;
  #heldTeams: Set<string> | undefined;

  readonly #core: Core;
  readonly #resumes: ResumePlanner;

  constructor(core: Core, private readonly threads: ThreadStore, resumes: ResumePlanner) {
    this.#core = core;
    this.#resumes = resumes;
    core.bus.onCommitted((name, payload) => {
      if (!this.#closed && this.#started && name === 'thread.background') this.#watchBackground((payload as RpcEvents['thread.background']).threadId);
    });
  }

  /**
   * Whether the previous core died under its work rather than being stopped
   * on purpose, recently enough for that work to go on: within the hour a
   * restart handoff keeps, counted from its last thread event. Read before
   * this core writes any, so call it before recovery.
   */
  previousRunCut(): boolean {
    if (this.#cut === undefined) {
      const row = this.#core.journal.db.query("SELECT ts FROM events WHERE thread_id IS NOT NULL AND type != 'thread.background.interrupted' ORDER BY id DESC LIMIT 1").get() as { ts: number } | null;
      this.#cut = this.#core.journal.getSetting(STOPPED_KEY) == null && row !== null && Date.now() - row.ts <= HANDOFF.maxAgeMs;
    }
    return this.#cut;
  }

  /**
   * The owner stops this core without a handoff (`core.shutdown`, `SIGINT`,
   * `POST /shutdown`): what it cuts is his decision, not a crash.
   */
  noteDeliberateStop(): void {
    if (!this.#core.journal.isClosed()) this.#core.journal.setSetting(STOPPED_KEY, Date.now());
  }

  /** Whether a turn the previous core left running resumes once this one starts. Recovery closes it either way. */
  resumesCrashed(turn: Turn): boolean {
    const thread = this.#core.journal.getThread(turn.threadId);
    if (thread === null || !this.#eligible(thread, turn) || !this.previousRunCut()) return false;
    // As `plan` decides: a turn already resumed, or a row out of resumes, gets none.
    const entry = this.#resumes.entry(turn.threadId);
    if (entry !== undefined && (entry.handled === turn.id || (entry.streak ?? 0) >= AUTO_CONTINUE.delaysMs.length)) return false;
    this.#crashed.push(turn);
    return true;
  }

  /**
   * Once recovery ran and the planner armed the plans a previous core left:
   * the turns it left running resume, then the threads whose background work,
   * team or workflow runs it cut with no turn running.
   */
  start(interrupted: Iterable<ThreadId> = []): void {
    try { this.#startPlans(interrupted); }
    // What the crash held is news only to the prompts of this start: a later one must not repeat it.
    finally { this.#heldTeams = new Set(); this.#heldRuns = new Set(); }
  }

  #startPlans(interrupted: Iterable<ThreadId>): void {
    this.#started = true;
    const cut = this.previousRunCut();
    this.#core.journal.deleteSetting(STOPPED_KEY);
    const resumed = new Set<ThreadId>();
    for (const turn of this.#crashed.splice(0)) {
      if (this.#resumes.planned(turn.threadId)) continue;
      const prompt = this.#withHeldWork(turn.threadId, this.threads.handoff.continuation(turn, RESUME_TEXT.crash.prompt));
      if (this.#plan(turn.threadId, turn, 'crash', prompt, AUTO_CONTINUE.startDelayMs)) resumed.add(turn.threadId);
    }
    if (!cut) return;
    const held = new Set([...interrupted, ...this.#teamsHeldByRestart(), ...this.#runsHeldByRestart()]);
    for (const threadId of held) {
      if (resumed.has(threadId) || this.#resumes.planned(threadId)) continue;
      const thread = this.#core.journal.getThread(threadId);
      const turn = thread ? this.#resumes.lastTurn(threadId) : null;
      // A team or a run can wait on a parent whose own turn was answered or failed: the restart still cut it.
      // One the user stopped stays stopped.
      if (thread === null || turn === null || turn.status === 'stopped' || !this.#eligible(thread, turn)) continue;
      const wait = turn.status === 'done' ? this.#interruptedWait(thread) : null;
      const cut = wait ? this.#backgroundPrompt(wait) : null;
      const prompt = this.#withHeldWork(threadId, cut ?? '', cut === null);
      if (prompt.length > 0) this.#plan(threadId, turn, 'background', prompt, AUTO_CONTINUE.startDelayMs);
    }
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#watches.values()) clearTimeout(timer);
    this.#watches.clear();
  }

  /**
   * A turn of the thread ended, its thread saved. An error or a turn that
   * ended on a compaction plans a resume; a turn answered well, or stopped,
   * ends the row of resumes.
   */
  turnFinished(thread: ThreadSummary, turn: Turn, result: TurnResult): void {
    if (this.#closed || this.#core.stopping || !this.#eligible(thread, turn)) return;
    if (turn.status === 'stopped') {
      this.#resumes.forget(thread.id);
      return;
    }
    if (turn.status === 'done') {
      if (this.#endsOnCompaction(turn)) {
        this.#plan(thread.id, turn, 'compaction', RESUME_TEXT.compaction.prompt);
        return;
      }
      if (this.#resumes.entry(thread.id)?.resumeTurnId !== turn.id) this.#resumes.forget(thread.id);
      // Background work it started may still end without waking it.
      this.#watchBackground(thread.id);
      return;
    }
    // A refusal has its own retry: a spent usage window resumes at its reset or
    // not at all (`limit-resume.ts`), capacity got its tries in the turn, and a
    // capacity wait the user cancelled must stay failed.
    if (result.refusal) return;
    const error = (turn.error ?? result.error ?? 'unknown error').trim();
    const quoted = error.length > ERROR_QUOTE ? `${error.slice(0, ERROR_QUOTE)} [cut]` : error;
    this.#plan(thread.id, turn, 'error', `Your previous turn ended on an error before it finished: ${quoted}\n\nBoite resumed the thread by itself. ${CARRY_ON}`);
  }

  /**
   * Background work an agent update ended with the agent's process: the
   * thread resumes like work that ended without waking it, which a session
   * ended on purpose otherwise does not (`watchBackground`). False when it
   * is not the user's own conversation or a resume is already planned.
   */
  resumeCut(threadId: ThreadId, prompt: string): boolean {
    const thread = this.#core.journal.getThread(threadId);
    const turn = this.#resumes.lastTurn(threadId);
    if (thread === null || turn === null || !this.#eligible(thread, turn) || this.#resumes.planned(threadId)) return false;
    return this.#plan(threadId, turn, 'background', this.#withHeldWork(threadId, prompt));
  }

  /**
   * Conversations of the user's, a persistent agent's among them: a delegated
   * agent answers its parent, which hears of its failure. A compaction, a
   * coordination wake or a cache ping is not worth repeating.
   */
  #eligible(thread: ThreadSummary, turn: Turn): boolean {
    if (thread.archived || thread.parentThreadId) return false;
    const operation = turn.execution?.operation;
    return operation !== 'compact' && operation !== 'coordination' && operation !== 'keepalive';
  }

  /**
   * Plans the thread's next resume, or ends its row: past the last delay, the
   * stop the resumes could not get past stays for the user. False when nothing
   * was planned.
   */
  #plan(threadId: ThreadId, turn: Turn, reason: StopReason, prompt: string, delayMs?: number): boolean {
    if (this.#closed || this.#core.journal.isClosed()) return false;
    const entry = this.#resumes.entry(threadId) ?? {};
    const streak = entry.streak ?? 0;
    if (entry.handled === turn.id) return false;
    if (streak >= AUTO_CONTINUE.delaysMs.length) {
      this.#resumes.settle(threadId, { streak: 0, handled: turn.id, ...(entry.resumedWindow !== undefined ? { resumedWindow: entry.resumedWindow } : {}) });
      this.#resumes.log('warn', threadId, `Turn ${turn.id} stopped again after ${streak} automatic resumes in a row; Boite leaves it to the user`, 'gave-up', null, { reason }, reason);
      return false;
    }
    const at = Date.now() + (delayMs ?? AUTO_CONTINUE.delaysMs[streak]!);
    this.#resumes.schedule(threadId, turn, { reason, at, prompt },
      `Turn ${turn.id} stopped before its answer (${reason}); the thread resumes at ${new Date(at).toISOString()}, resume ${streak + 1} of ${AUTO_CONTINUE.delaysMs.length}`);
    return true;
  }

  /** The turn's answer is a compaction and nothing after it: the agent never came back from it. */
  #endsOnCompaction(turn: Turn): boolean {
    // Newest first, and only as far as the last part that is not thinking.
    for (const message of this.#core.journal.walkAgentMessagesBackwards(turn.threadId, turn.id)) {
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
  #watchBackground(threadId: ThreadId): void {
    const watch = this.#watches.get(threadId);
    if (watch !== undefined) clearTimeout(watch);
    this.#watches.delete(threadId);
    if (this.#closed || this.#core.stopping || this.#core.journal.isClosed()) return;
    const thread = this.#core.journal.getThread(threadId);
    if (thread === null || thread.archived || thread.parentThreadId) return;
    const live = this.threads.agentState.background.get(threadId) ?? [];
    const wait = backgroundWaitOf(this.#core, thread, live);
    if (wait?.state === 'waiting' && wait.until !== null) {
      const timer = setTimeout(() => this.#watchBackground(threadId), Math.max(0, wait.until - Date.now()) + 50);
      timer.unref?.();
      this.#watches.set(threadId, timer);
      return;
    }
    if (wait?.state !== 'interrupted' || wait.reason === 'session-ended') return;
    const turn = this.#resumes.lastTurn(threadId);
    if (turn === null || !this.#eligible(thread, turn) || this.#resumes.planned(threadId)) return;
    this.#plan(threadId, turn, 'background', this.#withHeldWork(threadId, this.#backgroundPrompt(wait)));
  }

  #interruptedWait(thread: ThreadSummary): Extract<BackgroundWait, { state: 'interrupted' }> | null {
    const wait = backgroundWaitOf(this.#core, thread, this.threads.agentState.background.get(thread.id) ?? []);
    return wait?.state === 'interrupted' && wait.reason !== 'session-ended' ? wait : null;
  }

  #backgroundPrompt(wait: Extract<BackgroundWait, { state: 'interrupted' }>): string {
    return `Background work you started (${wait.for}) ended without waking you: ${INTERRUPTION_TEXT[wait.reason]}. Check its result and start again what did not finish. ${CARRY_ON}`;
  }

  /**
   * What a crash paused besides the turn: the subagent team and the workflow
   * runs, which wait for the agent to resume them. `alone` words it as the
   * whole prompt; an empty string when nothing was held.
   */
  #withHeldWork(threadId: ThreadId, prompt: string, alone = false): string {
    const held: string[] = [];
    if (this.#teamsHeldByRestart().has(threadId)) held.push('your subagent team');
    if (this.#runsHeldByRestart().has(threadId)) held.push('your workflow runs');
    if (held.length === 0) return prompt;
    const note = `Boite stopped unexpectedly and has started again; it paused ${held.join(' and ')} meanwhile. Run \`boite delegate resume\` to let them go on once you checked where they stand.`;
    return alone ? `${note} ${CARRY_ON}` : `${prompt}\n\n${note}`;
  }

  /** Conversations whose subagent team this core paused at its start because the previous one died (`delegation.ts`). */
  #teamsHeldByRestart(): Set<string> {
    this.#heldTeams ??= new Set((this.#core.journal.db.query("SELECT key FROM settings WHERE key LIKE 'delegation:%'").all() as { key: string }[])
      .map(row => row.key.slice('delegation:'.length))
      .filter(rootId => {
        const config = this.#core.delegation.config(rootId);
        return config.paused && config.pausedBy === 'restart' && (config.pausedAt ?? 0) >= this.#core.startedAt;
      }));
    return this.#heldTeams;
  }

  /** Conversations whose workflow runs this core paused at its start because the previous one died (`workflows.ts`). */
  #runsHeldByRestart(): Set<string> {
    this.#heldRuns ??= new Set((this.#core.journal.db.query(
      "SELECT root_id FROM workflow_runs WHERE status = 'paused' AND json_extract(data, '$.pausedBy') = 'restart' AND json_extract(data, '$.pausedAt') >= ?",
    ).all(this.#core.startedAt) as { root_id: string }[]).map(row => row.root_id));
    return this.#heldRuns;
  }
}
