import { threadActive } from '@boite/contracts';
import type { ActivityTurn, AgentTask, Attachment, ComposerChoice, GoalReview, MessagePart, RpcParams, ThreadActivity, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused } from './errors.ts';
import { isAgentHeld } from './agents/runtime.ts';
import { activityResult, parseVerdict, reviewPrompt } from './activity-prompt.ts';
import { checkAttachmentArray, checkAttachments } from './threads/inputs.ts';
import { assertDriverRunnable } from './drivers/index.ts';
import type { ChildRoute } from './delegation/routes.ts';
import { GoalTracker, modelRead, newChecklist } from './goal-tracker.ts';
import type { ProviderProbe } from './providers/probe.ts';
import { needsModelDiscovery } from './threads/selection.ts';
import { nativeCommandPrompt } from './threads/operations.ts';
import { addGoalCard, unlinkGoalCards } from './todos.ts';

const empty = (): ThreadActivity => ({ goal: null, loop: null, tasks: [] });
type PendingAttachments = Partial<Record<'goal' | 'loop', Attachment[]>>;
/** How a goal stopped working: met, waiting on the user, or paused by a failed or stopped turn. */
export interface GoalOutcome { threadId: string; outcome: 'complete' | 'blocked' | 'stopped'; text: string }
/** Reviews of a `/goal2` before it stops for the user. */
export const GOAL_REVIEW_ROUNDS = 5;
const newReview = (): GoalReview => ({ phase: 'working', maxRounds: GOAL_REVIEW_ROUNDS, reviewerThreadId: null, claimTurnId: null, delivered: 0, verdicts: [] });
/** Completion claims one open checklist item may send back before the review decides alone. */
export const CHECKLIST_BOUNCES = 2;
/** The review a reviewer conversation's first turn answers. */
interface ReviewRun { threadId: string; generation: number; round: number }

/** Activity survives reconnects; a restarted core requires an explicit resume. */
export class ActivityStore {
  private readonly states = new Map<string, ThreadActivity>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ownTurns = new Map<string, { kind: 'goal' | 'loop'; generation: number; iteration: number }>();
  private readonly generations = new Map<string, number>();
  private readonly goalListeners = new Set<(event: GoalOutcome) => void>();
  /** Every reviewer conversation of a `/goal2`: delegation treats them as steps it does not own. */
  private readonly reviewers = new Set<string>();
  /** Reviewer conversation to the review its first turn answers, until that turn ends. */
  private readonly reviewing = new Map<string, ReviewRun>();
  /** Goals whose last completion claim the checklist sent back: their next turn says so. */
  private readonly bounced = new Set<string>();
  /** Keeps each `/goal2`'s checklist ([goal-tracker](./goal-tracker.ts)). */
  readonly tracker: GoalTracker;
  /** Reads an agent's models before a reviewer starts on one; set by `modules.ts`. */
  private probe: ProviderProbe | null = null;
  /** Goals whose reviewer waits for its agent's models to be read. */
  private readonly readingModels = new Set<string>();
  /** The goal generation and round whose reviewer already had its models read: one read per review. */
  private readonly modelsRead = new Map<string, string>();
  private readonly readingTurnModels = new Set<string>();
  private closed = false;

  /** `threadJsonChecked`: the core validated visible thread JSON just before, with nothing written since. */
  constructor(private readonly core: Core, threadJsonChecked = false) {
    if (!threadJsonChecked) core.journal.validateVisibleThreadJson();
    this.tracker = new GoalTracker(core, {
      goal: threadId => this.states.get(threadId)?.goal ?? null,
      generation: threadId => this.generations.get(`${threadId}:goal`) ?? 0,
      save: threadId => this.save(threadId),
      checked: threadId => this.checklistChecked(threadId),
    });
    const savedThreads = core.journal.db.query(`SELECT threads.id FROM threads JOIN settings ON settings.key = 'activity:' || threads.id
      WHERE threads.id NOT IN (SELECT thread_id FROM thread_deletions) ORDER BY threads.rowid`).all() as { id: string }[];
    for (const thread of savedThreads) {
      const saved = core.journal.getSetting(`activity:${thread.id}`) as ThreadActivity | undefined;
      if (!saved) continue;
      // An automatic goal's first turn still in line runs as the goal's after the restart: with its rules, its claim or blocker counting.
      const first = firstInLine(core, thread.id, saved);
      if (first) this.ownTurns.set(first, { kind: 'goal', generation: 0, iteration: 1 });
      let changed = !first && pauseActivity(saved, 'Core restarted. Resume to continue.');
      const review = saved.goal?.review;
      for (const verdict of review?.verdicts ?? []) this.reviewers.add(verdict.threadId);
      // The interrupted review is not adopted: resuming starts a fresh one.
      if (review?.reviewerThreadId) { this.reviewers.add(review.reviewerThreadId); review.reviewerThreadId = null; changed = true; }
      if (saved.goal?.checklist && this.tracker.adopt(thread.id, saved.goal.checklist)) changed = true;
      for (const run of saved.loop?.history ?? []) {
        if (run.status === 'running') { run.status = 'error'; run.summary = 'Core restarted before this iteration finished.'; run.finishedAt = Date.now(); changed = true; }
      }
      this.states.set(thread.id, saved);
      if (changed) this.save(thread.id);
    }
    core.bus.onAny((name, payload) => {
      if (this.closed) return;
      if (name === 'turn.finished') this.finished(payload as Turn);
      if (name === 'message.part') {
        const event = payload as { threadId: string; part: MessagePart };
        this.observeTool(event.threadId, event.part);
      }
    });
    // An archive or removal that rolls back pauses, stops and forgets nothing.
    core.bus.onCommitted((name, payload) => {
      if (this.closed) return;
      if (name === 'thread.updated') {
        const thread = payload as { id: string; archived: boolean };
        if (thread.archived) this.pauseAll(thread.id);
      }
      if (name === 'thread.removed' && !(payload as { undoable?: boolean }).undoable) {
        const { threadId } = payload as { threadId: string };
        const review = this.reviewing.get(threadId);
        if (review) this.reviewEnded(review, threadId, 'The reviewer conversation was removed. Resume to review again.');
        for (const [reviewer, run] of this.reviewing) if (run.threadId === threadId) this.reviewing.delete(reviewer);
        this.reviewers.delete(threadId);
        this.tracker.removed(threadId);
        this.bounced.delete(threadId);
        this.readingModels.delete(threadId);
        this.modelsRead.delete(threadId);
        this.clearTimer(threadId);
        this.states.delete(threadId);
        core.journal.deleteSetting(`activity:${threadId}`);
        core.journal.deleteSetting(`activity-input:${threadId}`);
        core.journal.deleteSetting(`activity:shared:${threadId}`);
        core.journal.deleteSetting(`auto-goal:${threadId}`);
      }
    });
  }

  /** How reviewers and checklist trackers read an agent's models before starting on one. */
  useProbe(probe: ProviderProbe): void { this.probe = probe; this.tracker.useProbe(probe); }

  /** Called after the goal's new state is saved. Returns the unsubscribe. */
  onGoal(listener: (event: GoalOutcome) => void): () => void {
    this.goalListeners.add(listener);
    return () => { this.goalListeners.delete(listener); };
  }

  private goalEnded(event: GoalOutcome): void {
    for (const listener of this.goalListeners) {
      try { listener(event); } catch (error) { this.core.log('warn', `goal outcome listener: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** Pause after a failed or stopped turn, and tell observers when that stopped an active goal. */
  private stop(threadId: string, error: string): void {
    const active = this.states.get(threadId)?.goal?.status === 'active';
    this.pauseAll(threadId, error);
    if (active) this.goalEnded({ threadId, outcome: 'stopped', text: error });
  }

  get(threadId: string): ThreadActivity { return structuredClone(this.states.get(threadId) ?? empty()); }

  /** A `/goal2` reviewer: its answers go to the goal, never to the parent as mail. */
  ownsReviewer(threadId: string): boolean { return this.reviewers.has(threadId); }

  /** A `/goal2` checklist's tracker: its answers go to the checklist, never to the parent as mail. */
  ownsTracker(threadId: string): boolean { return this.tracker.owns(threadId); }

  /** A message of the user on a thread whose `/goal2` runs: its checklist may change. */
  userMessage(threadId: string, text: string): void {
    const goal = this.states.get(threadId)?.goal;
    if (goal?.checklist && goal.status !== 'complete') this.tracker.message(threadId, text);
  }

  /** A goal or a loop not finished yet, paused included: an automatic goal never replaces it. */
  busy(threadId: string): boolean {
    const state = this.states.get(threadId);
    return [state?.goal, state?.loop].some(item => item && item.status !== 'complete');
  }

  /**
   * An automatic goal (`auto-goal` experiment, `docs/goals.md`): the user's
   * message `messageId` becomes a reviewed goal's objective, verbatim, and
   * the project's board gets a card linked to it. False, and nothing changes,
   * when the conversation is a subthread or already holds a goal or a loop.
   * It never throws: the turn it follows is already accepted, so a goal that
   * cannot start is logged and the prompt runs alone.
   */
  autoGoal(threadId: string, turnId: string, messageId: string, objective: string, executionChoice?: ComposerChoice): boolean {
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived || thread.parentThreadId || this.busy(threadId) || !objective.trim()) return false;
    try { this.set({ threadId, goal: { objective, review: true } }, undefined, executionChoice, true); } catch (error) {
      this.core.log('warn', `automatic goal: ${messageOf(error)}`);
      return false;
    }
    // The turn still under way is the goal's first: its claim or blocker counts, and no second run starts before them.
    // `first` keeps that across a restart, while the turn waits in line.
    const first = ['queued', 'running', 'waiting'].includes(this.core.journal.getTurn(turnId)?.status ?? '');
    if (first) {
      this.ownTurns.set(turnId, { kind: 'goal', generation: this.generations.get(`${threadId}:goal`) ?? 0, iteration: 1 });
      this.states.get(threadId)!.goal!.iterations = 1;
      this.save(threadId);
    }
    this.core.journal.setSetting(`auto-goal:${threadId}`, { turnId, messageId, ...(first ? { first } : {}) });
    try { addGoalCard(this.core, threadId, objective); } catch (error) { this.core.log('warn', `automatic goal card: ${messageOf(error)}`); }
    return true;
  }

  /**
   * `boite goal track`: the agent asks for an automatic goal on the user's
   * last prompt, below the threshold. Refused while the experiment is off,
   * while a goal or a loop runs, and when that prompt already started one.
   */
  track(threadId: string): ThreadActivity {
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived) throw refused('goal track needs an existing, unarchived conversation');
    const experiments = this.core.clients.desktopExperiments() ?? this.core.clients.current()?.experiments ?? [];
    if (!experiments.includes('auto-goal')) throw refused('goal track needs the Automatic goals experiment, which is off in the desktop app (Settings, Experiments)', { reason: 'experiment-off' });
    if (this.busy(threadId)) throw refused('this conversation already has a goal or a loop; it must finish or be removed first', { reason: 'busy' });
    const last = this.lastPrompt(threadId);
    if (!last) throw refused('this conversation has no prompt of the user to track', { reason: 'no-prompt' });
    const started = this.core.journal.getSetting(`auto-goal:${threadId}`) as { messageId?: string } | undefined;
    if (started?.messageId === last.messageId) throw refused("the user's last prompt already started a goal", { reason: 'already-tracked' });
    if (!this.autoGoal(threadId, last.turnId, last.messageId, last.text)) throw refused('a reviewed goal starts reviewer conversations; start it in a top-level conversation', { reason: 'subthread' });
    return this.get(threadId);
  }

  /** The user's newest prompt, a steer included: no operation, no goal or loop turn, no native command. */
  private lastPrompt(threadId: string): { turnId: string; messageId: string; text: string } | null {
    for (const message of this.core.journal.walkMessages(threadId, { newestFirst: true, blobs: false })) {
      if (message.role !== 'user' || !message.turnId || this.core.journal.getTurn(message.turnId)?.execution?.operation) continue;
      const part = message.parts[0];
      if (part?.type !== 'text' || part.activity || part.startedBy) continue;
      const text = part.displayText ?? part.text;
      if (!text.trim() || nativeCommandPrompt(text)) continue;
      return { turnId: message.turnId, messageId: message.id, text };
    }
    return null;
  }

  /** A user's turn an automatic goal took as its first: the agent hears the goal's rules on it. */
  autoGoalTurn(turnId: string): boolean { return this.ownTurns.get(turnId)?.kind === 'goal'; }

  set(params: RpcParams<'threads.activity.set'>, sharedClaim?: {sharedProjectId: string; cardId: string; claimId: string}, executionChoice?: ComposerChoice, auto = false): ThreadActivity {
    const thread = this.core.journal.getThread(params.threadId);
    if (!thread || thread.archived) throw refused('activity requires an existing, unarchived thread');
    const attachments = params.attachments ?? [];
    checkAttachmentArray(attachments);
    if (attachments.length) checkAttachments(attachments, this.core.providers.require(thread.providerId));
    if (attachments.length && Number(!!params.goal) + Number(!!params.loop) !== 1) throw invalidParams('attachments require exactly one new goal or loop');
    const state = this.get(params.threadId);
    if (params.goal !== undefined) {
      if (params.goal !== null && (typeof params.goal.objective !== 'string' || !params.goal.objective.trim())) throw invalidParams('goal.objective must be non-empty text');
      if (params.goal && params.goal.review !== undefined && typeof params.goal.review !== 'boolean') throw invalidParams('goal.review must be a boolean');
      if (params.goal?.review && thread.parentThreadId) throw refused('a reviewed goal starts reviewer conversations; start it in a top-level thread');
      this.stopReview(params.threadId);
      this.bounced.delete(params.threadId);
      // A goal that replaces an automatic one leaves its card in To do, linked to nothing.
      if (state.goal?.auto) unlinkGoalCards(this.core, params.threadId);
      state.goal = params.goal === null ? null : { objective: auto ? params.goal.objective : params.goal.objective.trim(), status: 'active', iterations: 0, error: null, ...(params.goal.review ? { review: newReview(), checklist: newChecklist() } : {}), ...(auto ? { auto: true as const } : {}) };
      // This second argument is core-only. An ordinary RPC goal replacement cannot inherit another claim's stop authority.
      if (sharedClaim && params.goal) this.core.journal.setSetting(`activity:shared:${params.threadId}`, sharedClaim);
      else this.core.journal.deleteSetting(`activity:shared:${params.threadId}`);
    }
    if (params.loop !== undefined) {
      if (params.loop !== null) validateLoop(params.loop);
      state.loop = params.loop === null ? null : { prompt: params.loop.prompt.trim(), intervalMs: params.loop.intervalMs, maxIterations: params.loop.maxIterations ?? null, status: 'active', iterations: 0, nextRunAt: Date.now(), error: null, history: [] };
    }
    const pending = this.pendingAttachments(params.threadId);
    const choices = (this.core.journal.getSetting(`activity-choice:${params.threadId}`) as Partial<Record<'goal' | 'loop', ComposerChoice>> | undefined) ?? {};
    for (const kind of ['goal', 'loop'] as const) if (params[kind] !== undefined) {
      const key = `${params.threadId}:${kind}`;
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      if (params[kind] && attachments.length) pending[kind] = structuredClone(attachments);
      else delete pending[kind];
      if (params[kind] && executionChoice) choices[kind] = executionChoice;
      else delete choices[kind];
    }
    if (Object.keys(choices).length) this.core.journal.setSetting(`activity-choice:${params.threadId}`, choices);
    else this.core.journal.deleteSetting(`activity-choice:${params.threadId}`);
    this.saveAttachments(params.threadId, pending);
    this.states.set(params.threadId, state);
    this.save(params.threadId);
    if (params.goal !== undefined) {
      if (state.goal?.checklist) this.tracker.begin(params.threadId);
      else this.tracker.stop(params.threadId);
    }
    this.schedule(params.threadId, 0);
    return this.get(params.threadId);
  }

  control(params: RpcParams<'threads.activity.control'>): ThreadActivity {
    if (!['goal', 'loop'].includes(params.kind) || !['pause', 'resume', 'remove', 'complete'].includes(params.action)) throw invalidParams('activity kind or action is invalid');
    const thread = this.core.journal.getThread(params.threadId);
    if (!thread) throw refused('activity requires an existing thread');
    if (params.action === 'resume' && thread.archived) throw refused('cannot resume activity on an archived thread');
    const state = this.get(params.threadId);
    const item = state[params.kind];
    if (!item) throw refused(`this thread has no ${params.kind}`);
    if (params.action === 'resume' && params.kind === 'loop' && state.loop?.maxIterations && state.loop.iterations >= state.loop.maxIterations) throw refused('this loop has finished all its iterations; start a new loop');
    if (params.action === 'complete' && params.kind !== 'goal') throw invalidParams('only a goal can be completed');
    // A finished loop cannot resume, so pausing it would leave it stuck on `paused`.
    if (params.action === 'pause' && item.status === 'complete') throw refused(`this ${params.kind} is complete; there is nothing to pause`);
    // Paused, removed or finished by hand, a goal stops paying for its review.
    if (params.kind === 'goal' && params.action !== 'resume') this.stopReview(params.threadId);
    // A removed automatic goal leaves its card in To do, linked to nothing.
    if (params.action === 'remove' && params.kind === 'goal' && state.goal?.auto) unlinkGoalCards(this.core, params.threadId);
    if (params.action === 'remove') state[params.kind] = null;
    else if (params.action === 'complete' && state.goal) {
      state.goal.status = 'complete'; delete state.goal.blocked;
      if (state.goal.review) Object.assign(state.goal.review, { phase: 'working', reviewerThreadId: null });
    }
    else { item.status = params.action === 'resume' ? 'active' : 'paused'; item.error = null; if (params.kind === 'goal' && state.goal) { state.goal.dismissed = false; delete state.goal.blocked; } }
    if (params.action === 'remove' || params.action === 'complete') {
      const key = `${params.threadId}:${params.kind}`;
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      const pending = this.pendingAttachments(params.threadId);
      delete pending[params.kind];
      this.saveAttachments(params.threadId, pending);
    }
    if (state.loop && state.loop.status !== 'active') state.loop.nextRunAt = null;
    if (params.kind === 'loop' && params.action === 'resume' && state.loop) state.loop.nextRunAt = Date.now();
    this.states.set(params.threadId, state);
    // A paused goal's checklist still follows the conversation; a removed or finished one stops, on the state just stored.
    if (params.kind === 'goal' && (params.action === 'remove' || params.action === 'complete')) { this.tracker.stop(params.threadId); this.bounced.delete(params.threadId); }
    this.save(params.threadId);
    this.schedule(params.threadId, 0);
    return this.get(params.threadId);
  }

  tasks(threadId: string, tasks: AgentTask[]): void {
    const state = this.get(threadId);
    if (tasks.some(task => task.status !== 'completed' || !state.tasks.some(old => old.id === task.id && old.text === task.text))) state.tasksDismissed = false;
    state.tasks = tasks;
    this.states.set(threadId, state);
    this.save(threadId);
  }

  /**
   * A new user request retires the finished overlay without deleting its
   * history, and answers a blocked goal: the goal resumes after that turn.
   */
  userPrompt(threadId: string, answers = true): void {
    this.prepareUserPrompt(threadId, answers)?.();
  }

  /** Write the dismissal row in the caller's transaction; apply memory and notify after commit. */
  prepareUserPrompt(threadId: string, answers = true): (() => void) | undefined {
    const previous = this.states.get(threadId);
    if (!previous) return;
    const state = { ...previous, goal: previous.goal ? { ...previous.goal } : null };
    let changed = false;
    if (state.tasks.length && state.tasks.every(task => task.status === 'completed') && !state.tasksDismissed) { state.tasksDismissed = true; changed = true; }
    if (state.goal?.status === 'complete' && !state.goal.dismissed) { state.goal.dismissed = true; changed = true; }
    // The reply turn runs first; its `turn.finished` schedules the next goal turn.
    // A native command such as `/cost` is not an answer.
    if (answers && state.goal?.status === 'paused' && state.goal.blocked) { state.goal.status = 'active'; state.goal.error = null; delete state.goal.blocked; changed = true; }
    if (!changed) return;
    this.core.journal.setSetting(`activity:${threadId}`, state);
    return () => {
      this.states.set(threadId, state);
      this.core.bus.emit('thread.activity', { threadId, activity: this.get(threadId) });
    };
  }

  private observeTool(threadId: string, part: MessagePart): void {
    if (part.type !== 'tool' || part.status !== 'done' || !part.input || typeof part.input !== 'object') return;
    const input = part.input as Record<string, unknown>;
    if (/^(?:TodoWrite|write_todos|update_plan|functions[.]update_plan)$/i.test(part.name)) {
      const items = input.todos ?? input.plan;
      if (Array.isArray(items)) this.tasks(threadId, normalizeTasks(items));
    }
    if (/^(?:TaskCreate|TaskUpdate)$/i.test(part.name)) {
      const state = this.get(threadId);
      let createdId: string | null = null;
      if (part.name.toLowerCase() === 'taskcreate') {
        createdId = createdTaskId(part.output);
        if (!createdId) return;
      }
      const id = String(input.taskId ?? createdId);
      const old = state.tasks.find((task) => task.id === id);
      const text = typeof input.subject === 'string' ? input.subject : old?.text;
      if (!text) return;
      const task = { id, text, status: taskStatus(input.status ?? old?.status) };
      state.tasks = [...state.tasks.filter((entry) => entry.id !== id), task];
      this.tasks(threadId, state.tasks);
    }
  }

  private finished(turn: Turn): void {
    const review = this.reviewing.get(turn.threadId);
    if (review) { this.reviewFinished(turn, review); return; }
    if (this.tracker.finished(turn)) return;
    const owned = this.ownTurns.get(turn.id);
    this.ownTurns.delete(turn.id);
    const state = this.states.get(turn.threadId);
    // Every finished turn of the conversation, the user's included: the goal's next turn waits for this check.
    if (turn.status === 'done' && !turn.execution?.operation && state?.goal?.checklist && state.goal.status !== 'complete') this.tracker.turnEnded(turn.threadId, turn.id);
    const current = owned && owned.generation === (this.generations.get(`${turn.threadId}:${owned.kind}`) ?? 0);
    if (current && owned.kind === 'loop' && state?.loop) {
      const run = state.loop.history?.find(run => run.turnId === turn.id);
      if (run) {
        run.status = turn.status === 'done' ? 'done' : turn.status === 'stopped' ? 'stopped' : 'error';
        run.finishedAt = turn.finishedAt ?? Date.now();
        run.summary = this.answer(turn).slice(0, 4000) || turn.error || '';
      }
      if (turn.status === 'done' && state.loop.maxIterations && state.loop.iterations >= state.loop.maxIterations) { state.loop.status = 'complete'; state.loop.nextRunAt = null; }
      else if (state.loop.status === 'active') state.loop.nextRunAt = Date.now() + state.loop.intervalMs;
      this.save(turn.threadId);
    }
    if (turn.status !== 'done' && (!owned || current)) { this.stop(turn.threadId, turn.error ?? 'Turn stopped. Resume to continue.'); return; }
    if (!state) return;
    if (owned?.kind === 'goal' && current && state.goal?.status === 'active') {
      const signal = this.goalResult(turn);
      // Clients that know `blocked` show their own words; the error serves older ones.
      const reviewed = state.goal.review;
      if (signal === 'blocked') { state.goal.status = 'paused'; state.goal.blocked = true; state.goal.error = 'The agent reported a blocker. Reply to resume.'; this.save(turn.threadId); }
      // A reviewed goal's completion is a claim; the scheduled run starts its review.
      else if (signal === 'complete' && reviewed) { Object.assign(reviewed, { phase: 'reviewing', claimTurnId: turn.id }); this.save(turn.threadId); }
      else if (signal === 'complete') { state.goal.status = 'complete'; this.save(turn.threadId); }
      if (signal && !(signal === 'complete' && reviewed) && this.goalListeners.size) this.goalEnded({ threadId: turn.threadId, outcome: signal, text: this.answer(turn) });
    }
    // Let the scheduler release its running slot and clients submit queued user input first.
    this.schedule(turn.threadId, 250);
  }

  /** The turn's assistant text without goal markers. */
  private answer(turn: Pick<Turn, 'threadId' | 'id'>): string {
    return activityResult(Array.from(this.core.journal.walkTurnMessages(turn.threadId, turn.id, { blobs: false })).filter(message => message.role === 'assistant').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n'));
  }

  private goalResult(turn: Turn): 'complete' | 'blocked' | null {
    let result: 'complete' | null = null;
    for (const message of this.core.journal.walkTurnMessages(turn.threadId, turn.id, { blobs: false })) {
      if (message.role !== 'assistant') continue;
      for (const part of message.parts) {
        if (part.type !== 'text') continue;
        const signal = goalSignal(part.text);
        if (signal === 'blocked') return signal;
        if (signal === 'complete') result = signal;
      }
    }
    return result;
  }

  private run(threadId: string, discovered?: string): void {
    if (this.closed || this.readingTurnModels.has(threadId)) return;
    const thread = this.core.journal.getThread(threadId);
    const state = this.states.get(threadId);
    if (!thread || !state || thread.archived) return;
    if (threadActive(thread.status)) return;
    const kind = state.loop?.status === 'active' && (state.loop.nextRunAt ?? 0) <= Date.now() ? 'loop' : state.goal?.status === 'active' ? 'goal' : null;
    if (!kind) {
      if (state.loop?.status === 'active') this.schedule(threadId, Math.max(0, (state.loop.nextRunAt ?? Date.now()) - Date.now()));
      return;
    }
    const review = kind === 'goal' ? state.goal!.review : undefined;
    // The checklist's check of the last turn decides what the next turn hears, or whether a claim goes back.
    if (kind === 'goal' && this.tracker.holds(threadId)) return;
    if (review?.phase === 'reviewing') { this.startReview(threadId, thread); return; }
    const last = review?.verdicts.at(-1);
    // Only the first turn after a review carries its findings; later ones have them in the history.
    const feedback = review && last && last.verdict !== 'pass' && review.delivered < review.verdicts.length ? { round: last.round, feedback: last.summary } : undefined;
    const list = kind === 'goal' ? state.goal!.checklist : undefined;
    const prompt = `/${review ? 'goal2' : kind} ${kind === 'goal' ? state.goal!.objective : state.loop!.prompt}`;
    const iteration = state[kind]!.iterations + 1;
    try {
      const pending = this.pendingAttachments(threadId);
      const choice = (this.core.journal.getSetting(`activity-choice:${threadId}`) as Partial<Record<'goal' | 'loop', ComposerChoice>> | undefined)?.[kind];
      const provider = choice ? this.core.providers.require(choice.providerId) : null;
      const generation = this.generations.get(`${threadId}:${kind}`) ?? 0;
      const attempt = JSON.stringify([kind, generation, choice]);
      if (choice && this.probe && provider && discovered !== attempt && needsModelDiscovery(provider, choice.accountId, choice.model, choice.effort, choice.speed ?? null)) {
        const read = this.probe({ providerId: choice.providerId, accountId: choice.accountId, ...(provider.protocol === 'acp' && choice.model !== null && choice.effort !== null ? { model: choice.model } : {}) });
        this.readingTurnModels.add(threadId);
        void read.then(() => {
          this.readingTurnModels.delete(threadId);
          // Validate this attempt once, even when the target read has no effort
          // metadata. A changed activity still discovers its own selection.
          this.run(threadId, attempt);
        }, error => {
          this.readingTurnModels.delete(threadId);
          if (this.closed || !this.core.journal.getThread(threadId)) return;
          if (generation === (this.generations.get(`${threadId}:${kind}`) ?? 0) && this.states.get(threadId)?.[kind]?.status === 'active') this.stop(threadId, messageOf(error));
          else this.schedule(threadId, 0);
        });
        return;
      }
      const checklist = list?.items.length ? { open: list.items.filter(item => item.status === 'open').map(item => item.text), bounced: this.bounced.delete(threadId) } : undefined;
      const turnActivity: ActivityTurn = { kind, iteration, ...(feedback ? { review: feedback } : {}), ...(checklist ? { checklist } : {}) };
      const turn = this.core.threads.startTurn(threadId, { prompt, attachments: pending[kind] ?? [] }, { kind: 'goal', activity: turnActivity }, { choice });
      delete pending[kind];
      this.saveAttachments(threadId, pending);
      this.ownTurns.set(turn.id, { kind, generation: this.generations.get(`${threadId}:${kind}`) ?? 0, iteration });
      // Drivers may synchronously report tasks while startTurn runs.
      const current = this.states.get(threadId)!;
      current[kind]!.iterations++;
      if (feedback && current.goal?.review) current.goal.review.delivered = current.goal.review.verdicts.length;
      if (kind === 'loop') {
        current.loop!.nextRunAt = null;
        current.loop!.history = [...(current.loop!.history ?? []), { iteration, turnId: turn.id, status: 'running' as const, summary: '', startedAt: Date.now(), finishedAt: null }].slice(-50);
      }
      this.save(threadId);
    } catch (error) {
      // A persistent agent that is paused or out of budget: the goal waits for it rather than ending.
      if (isAgentHeld(error)) { this.core.agentRuntime.whenAdmitted(threadId, 'goal', () => this.run(threadId)); return; }
      this.stop(threadId, error instanceof Error ? error.message : String(error));
    }
  }

  private schedule(threadId: string, delay: number): void {
    this.clearTimer(threadId);
    if (this.closed) return;
    const state = this.states.get(threadId);
    if (state?.goal?.status !== 'active' && state?.loop?.status !== 'active') return;
    this.timers.set(threadId, setTimeout(() => { this.timers.delete(threadId); this.run(threadId); }, delay));
  }

  private clearTimer(threadId: string): void { const timer = this.timers.get(threadId); if (timer) clearTimeout(timer); this.timers.delete(threadId); }

  /** Pending uploads survive pause/restart without bloating activity snapshots sent to clients. */
  private pendingAttachments(threadId: string): PendingAttachments {
    return this.core.journal.getSetting(`activity-input:${threadId}`) as PendingAttachments | undefined ?? {};
  }

  private saveAttachments(threadId: string, pending: PendingAttachments): void {
    if (Object.keys(pending).length) this.core.journal.setSetting(`activity-input:${threadId}`, pending);
    else this.core.journal.deleteSetting(`activity-input:${threadId}`);
  }

  pauseAll(threadId: string, error: string | null = null): void {
    const state = this.states.get(threadId);
    if (!state) return;
    this.clearTimer(threadId);
    if (!this.closed) this.stopReview(threadId);
    if (pauseActivity(state, error)) this.save(threadId);
  }

  // -- reviewed goals (`/goal2`) ----------------------------------------------

  /** A fresh child conversation with none of the agent's context judges the claim. */
  private startReview(threadId: string, parent: ThreadSummary): void {
    const goal = this.states.get(threadId)?.goal;
    const review = goal?.review;
    if (!goal || !review || goal.status !== 'active' || review.phase !== 'reviewing' || this.readingModels.has(threadId)) return;
    for (const run of this.reviewing.values()) if (run.threadId === threadId) return;
    const round = review.verdicts.length + 1;
    const generation = this.generations.get(`${threadId}:goal`) ?? 0;
    let reviewer: string | null = null;
    try {
      const route = this.reviewerRoute(parent);
      // An account change since the last read forgets its agent's models: read them, as a spawn does, then
      // start through the scheduler, which finds the goal as it is then: replaced, paused or still reviewing.
      const attempt = `${generation}:${round}`;
      const read = this.modelsRead.get(threadId) === attempt ? null : modelRead(this.core, this.probe, route);
      if (read) {
        this.modelsRead.set(threadId, attempt);
        this.readingModels.add(threadId);
        void read.catch(() => undefined).then(() => { this.readingModels.delete(threadId); this.schedule(threadId, 0); });
        return;
      }
      const provider = this.core.providers.require(route.providerId);
      assertDriverRunnable(provider.protocol, this.core.providers.summary(provider.id), this.core.accounts.require(route.accountId), () => this.core.providers.launcherScriptOnly(provider.id));
      const claim = review.claimTurnId ? this.answer({ threadId, id: review.claimTurnId }) : '';
      reviewer = this.core.delegation.createChild(parent, route, `Review ${round} · ${goal.objective}`.slice(0, 120), id => { this.reviewers.add(id); });
      this.reviewing.set(reviewer, { threadId, generation, round });
      review.reviewerThreadId = reviewer;
      this.save(threadId);
      this.core.threads.startTurn(reviewer, { prompt: reviewPrompt(goal.objective, claim, round, goal.checklist?.items ?? []), display: `Review the goal: ${goal.objective}`.slice(0, 500) }, { kind: 'delegation' });
    } catch (error) {
      if (reviewer) this.reviewing.delete(reviewer);
      review.reviewerThreadId = null;
      this.stop(threadId, `The review could not start: ${messageOf(error)}`);
    }
  }

  /** The owner's delegation profile named "reviewer" (another agent, say), else this conversation's own model. */
  private reviewerRoute(parent: ThreadSummary): ChildRoute {
    const named = this.core.delegation.config(parent.id).profiles.find(p => p.id.toLowerCase() === 'reviewer' || p.name.trim().toLowerCase() === 'reviewer');
    return this.core.delegation.resolve(parent.id, { profileId: named?.id ?? null });
  }

  private reviewFinished(turn: Turn, run: ReviewRun): void {
    if (turn.status !== 'done') { this.reviewEnded(run, turn.threadId, `The review ${turn.status === 'stopped' ? 'was stopped' : `failed: ${turn.error ?? 'no error given'}`}. Resume to review again.`); return; }
    this.reviewing.delete(turn.threadId);
    const goal = this.states.get(run.threadId)?.goal;
    const review = goal?.review;
    if (!goal || !review || run.generation !== (this.generations.get(`${run.threadId}:goal`) ?? 0) || review.reviewerThreadId !== turn.threadId) return;
    const { verdict, summary } = parseVerdict(this.answer(turn));
    review.verdicts.push({ round: run.round, verdict, summary, threadId: turn.threadId, finishedAt: turn.finishedAt ?? Date.now() });
    Object.assign(review, { phase: 'working', reviewerThreadId: null });
    let outcome: GoalOutcome['outcome'] | null = null;
    if (verdict === 'pass') { goal.status = 'complete'; goal.error = null; delete goal.blocked; outcome = 'complete'; }
    else if (goal.status === 'active' && review.verdicts.length >= review.maxRounds) {
      Object.assign(goal, { status: 'paused', blocked: true, error: `${review.verdicts.length} reviews did not pass. Reply to steer the agent; the goal resumes after your reply.` });
      outcome = 'blocked';
    }
    this.save(run.threadId);
    if (outcome) this.goalEnded({ threadId: run.threadId, outcome, text: outcome === 'complete' && review.claimTurnId ? this.answer({ threadId: run.threadId, id: review.claimTurnId }) : summary });
    this.schedule(run.threadId, 250);
  }

  /** A review that ended without a verdict leaves the goal paused on review, so a resume starts another. */
  private reviewEnded(run: ReviewRun, reviewer: string, error: string): void {
    this.reviewing.delete(reviewer);
    const goal = this.states.get(run.threadId)?.goal;
    if (!goal?.review || run.generation !== (this.generations.get(`${run.threadId}:goal`) ?? 0) || goal.review.reviewerThreadId !== reviewer) return;
    goal.review.reviewerThreadId = null;
    if (goal.status === 'active') this.stop(run.threadId, error);
    else this.save(run.threadId);
  }

  /**
   * The checklist read the agent's last turn. A completion claim with an item
   * still open goes back to the agent instead of to a reviewer, at most
   * `CHECKLIST_BOUNCES` times per item; after that the review judges alone.
   */
  private checklistChecked(threadId: string): void {
    const goal = this.states.get(threadId)?.goal;
    const review = goal?.review;
    if (goal?.status === 'active' && review?.phase === 'reviewing' && !review.reviewerThreadId && goal.checklist) {
      const open = goal.checklist.items.filter(item => item.status === 'open' && (item.bounced ?? 0) < CHECKLIST_BOUNCES);
      if (open.length) {
        for (const item of open) item.bounced = (item.bounced ?? 0) + 1;
        Object.assign(review, { phase: 'working', claimTurnId: null });
        this.bounced.add(threadId);
        this.save(threadId);
      }
    }
    this.schedule(threadId, 0);
  }

  private stopReview(threadId: string): void {
    for (const [reviewer, run] of this.reviewing) {
      if (run.threadId !== threadId) continue;
      try { this.core.threads.stopTurn(reviewer); } catch (error) { this.core.log('warn', `goal review ${reviewer}: ${messageOf(error)}`); }
    }
  }

  private save(threadId: string): void {
    const activity = this.get(threadId);
    // The settings row alone restores the state. An event row per save held the
    // whole loop history, up to 200 KB on every task-list update, and nothing read it.
    this.core.journal.setSetting(`activity:${threadId}`, activity);
    this.core.bus.emit('thread.activity', { threadId, activity });
  }

  close(): void {
    this.closed = true;
    this.tracker.close();
    for (const [threadId, state] of this.states) {
      // The next core runs an automatic goal's first turn still in line as the goal's (constructor).
      if (firstInLine(this.core, threadId, state)) this.clearTimer(threadId);
      else this.pauseAll(threadId);
    }
  }
}

export function validateLoop(loop: NonNullable<RpcParams<'threads.activity.set'>['loop']>): void {
  if (typeof loop.prompt !== 'string' || !loop.prompt.trim()) throw invalidParams('loop.prompt must be non-empty text');
  if (loop.maxIterations != null && (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1 || loop.maxIterations > 1000)) throw invalidParams('loop.maxIterations must be an integer from 1 to 1000');
  if (!Number.isInteger(loop.intervalMs) || loop.intervalMs > 86_400_000 || (loop.intervalMs !== 0 && loop.intervalMs < 1000) || (loop.intervalMs === 0 && !loop.maxIterations)) throw invalidParams('loop.intervalMs must be from 1000 to 86400000, or 0 with maxIterations');
}

export function taskStatus(value: unknown): AgentTask['status'] { return value === 'completed' ? 'completed' : value === 'in_progress' || value === 'inProgress' ? 'in_progress' : 'pending'; }

function createdTaskId(text: string | null): string | null {
  try {
    const output = JSON.parse(text ?? 'null');
    const id = output?.task?.id ?? output?.taskId ?? output?.id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  } catch { /* Older agents return a human-readable confirmation. */ }
  return /Task\s+#?(\d+)\s+created/i.exec(text ?? '')?.[1] ?? null;
}

/** The queued user's turn an automatic goal took as its first, while the goal waits on it: `autoGoal` stores `first`. */
function firstInLine(core: Core, threadId: string, state: ThreadActivity): string | null {
  const started = core.journal.getSetting(`auto-goal:${threadId}`) as { turnId?: string; first?: boolean } | undefined;
  const goal = state.goal;
  if (!started?.first || !started.turnId || !goal?.auto || goal.status !== 'active' || goal.iterations !== 1 || state.loop?.status === 'active') return null;
  return core.journal.getTurn(started.turnId)?.status === 'queued' ? started.turnId : null;
}

function pauseActivity(state: ThreadActivity, error: string | null): boolean {
  let changed = false;
  for (const item of [state.goal, state.loop]) {
    if (item?.status !== 'active') continue;
    item.status = 'paused';
    item.error = error;
    changed = true;
  }
  if (state.loop && state.loop.nextRunAt !== null) {
    state.loop.nextRunAt = null;
    changed = true;
  }
  return changed;
}

/** Only a final standalone marker outside fenced or indented code is a signal. */
export function goalSignal(text: string): 'complete' | 'blocked' | null {
  let fence: string | null = null;
  let last = '';
  for (const line of text.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && mark[2]!.trim() === '') fence = null;
      if (line.trim()) last = '';
      continue;
    }
    if (mark) { fence = mark[1]!; last = ''; continue; }
    if (line.trim()) last = line;
  }
  if (/^ {0,3}\[BOITE_GOAL_COMPLETE\][ \t]*$/.test(last)) return 'complete';
  if (/^ {0,3}\[BOITE_GOAL_BLOCKED\][ \t]*$/.test(last)) return 'blocked';
  return null;
}
export function normalizeTasks(items: unknown[]): AgentTask[] {
  return items.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const text = row.content ?? row.step ?? row.text;
    return typeof text === 'string' ? [{ id: String(row.id ?? index), text, status: taskStatus(row.status) }] : [];
  });
}
