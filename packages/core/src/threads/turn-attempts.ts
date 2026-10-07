import type { Account, PermissionMode, ProviderDescriptor, ProviderId, RpcEvents, ThreadId, ThreadSummary, Turn, TurnId, Usage } from '@boite/contracts';
import type { Core } from '../core.ts';
import { releaseThread } from '../drivers/index.ts';
import type { Driver, TurnHandle, TurnResult } from '../drivers/types.ts';
import type { Resume } from '../providers/update-resume.ts';
import type { ThreadStore } from '../threads.ts';
import { totalTokens } from '../usage.ts';
import { LivePermissions } from './live-permissions.ts';
import { LiveSettings } from './live-settings.ts';
import { saveThread, setThreadStatus } from './records.ts';
import type { CarriedInput } from './turn-context.ts';

/** The current attempt snapshots, shared with live controls and final settlement. */
export interface TurnAttemptState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  thread: ThreadSummary;
  running: Turn;
}

/** Resolved once from the admitted execution target, before native preparation yields. */
export interface TurnAttemptTarget {
  readonly provider: ProviderDescriptor;
  readonly account: Account;
  readonly driver: Driver;
}

/**
 * How long a stopped turn may take to settle. Past `ms` the core ends the
 * thread's processes, which is what makes the ACP, pi and Codex sessions see
 * their agent gone; past `ms + forceMs` it settles the turn itself. Mutable so
 * a test can shorten it.
 */
export const STOP_DEADLINE = { ms: 10_000, forceMs: 2_000 };
export const STOP_DEADLINE_ERROR = 'The agent did not stop in time; its processes were ended.';

interface StopDeadline {
  handle: TurnHandle;
  forced: { promise: Promise<TurnResult>; resolve: (result: TurnResult) => void };
  timer: ReturnType<typeof setTimeout> | null;
}

/** Native attempts and their active controls belong to one visible turn. */
export class TurnAttempts {
  readonly handles = new Map<ThreadId, TurnHandle>();
  private readonly livePermissions = new Map<ThreadId, LivePermissions>();
  private readonly liveSettings = new Map<ThreadId, { state: TurnAttemptState; settings: LiveSettings }>();
  /** Per running turn: what settles it when its driver never answers a stop. */
  private readonly stopDeadlines = new Map<ThreadId, StopDeadline>();
  /** Threads whose running turn the user stopped: a lost session is not retried for them. */
  private readonly stopRequested = new Set<ThreadId>();
  private readonly preparing = new Set<ThreadId>();
  /** Turns an agent update asked to pause at their next tool boundary. */
  private readonly pauseWanted = new Map<ThreadId, ProviderId>();
  /** Turns whose driver was stopped to pause them, not by the user. */
  private readonly pausing = new Set<ThreadId>();
  /** Paused turns, with what ends their pause early: a stop or the core closing. */
  private readonly paused = new Map<ThreadId, () => void>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    core.bus.onAny((name, payload) => {
      if (name === 'turn.toolCompleted') this.toolBoundary((payload as RpcEvents['turn.toolCompleted']).threadId);
    });
  }

  open(state: TurnAttemptState): LivePermissions {
    const { threadId } = state;
    const permissions = new LivePermissions(state.thread.permissionMode, handle => {
      this.threads.cards.clearPermissionsOf(threadId);
      this.threads.cards.clearQuestionsOf(threadId);
      handle.stop();
      this.armStopDeadline(threadId, handle);
    }, mode => {
      state.thread.permissionMode = mode;
      if (state.running.execution) state.running.execution = { ...state.running.execution, permissionMode: mode };
      this.core.journal.putTurn(state.running);
      this.threads.cards.applyPermissionMode(threadId, mode);
    });
    this.livePermissions.set(threadId, permissions);
    const settings = new LiveSettings(() => ({ effort: state.thread.effort, speed: state.thread.speed ?? null }), taken => {
      state.thread = { ...state.thread, ...taken };
      if (state.running.execution) state.running.execution = { ...state.running.execution, ...taken };
      this.core.journal.putTurn(state.running);
    });
    this.liveSettings.set(threadId, { state, settings });
    return permissions;
  }

  /**
   * The thread's effort or speed moved while its turn runs. They only mean
   * something on the model the turn started on: a selection that also changed
   * the model or the account waits for the next turn whole.
   */
  changeSettings(threadId: ThreadId, selection: Pick<ThreadSummary, 'accountId' | 'model' | 'effort' | 'speed'>): void {
    const live = this.liveSettings.get(threadId);
    if (live === undefined) return;
    if (selection.accountId !== live.state.thread.accountId || selection.model !== live.state.thread.model) return;
    live.settings.change({ effort: selection.effort, speed: selection.speed ?? null });
  }

  changePermissionMode(threadId: ThreadId, mode: PermissionMode): void {
    this.livePermissions.get(threadId)?.change(mode);
  }

  async run(queued: Turn, state: TurnAttemptState, target: TurnAttemptTarget, permissions: LivePermissions): Promise<TurnResult> {
    const { threadId, turnId } = state;
    const { provider, account, driver } = target;
    this.stopRequested.delete(threadId);
    this.preparing.add(threadId);
    const checkpoint = this.threads.codeCheckpoints.begin(state.thread, turnId);
    if (checkpoint) await checkpoint;
    this.preparing.delete(threadId);
    if (this.stopRequested.has(threadId)) return { status: 'stopped', sessionId: state.thread.sessionId, usage: null };

    // Keep consumed input so a retry on a fresh session sends it too.
    const carried: CarriedInput = {};
    let retriedLostSession = false;
    let resumed = false;
    let usage: Usage | null = null;
    let result: TurnResult;
    /** What the agent is told when its turn goes on after an agent update. */
    let afterUpdate: Resume | null = null;
    for (;;) {
      state.thread.permissionMode = permissions.mode;
      const note = afterUpdate;
      afterUpdate = null;
      // The resumed session already holds what the first attempt took from the thread.
      const context = this.threads.contexts.makeContext(state.thread, provider, account, state.running, note ? { memory: '', deferred: '', letters: '' } : carried, note?.prompt);
      if (note) {
        // Shown once the context is built, so a fresh session's history does not carry it twice.
        this.threads.noteSystem(threadId, turnId, note.prompt, note.label, 'turn.resumedAfterUpdate');
        if (usage) context.sessionBefore = {
          costUsd: (context.sessionBefore?.costUsd ?? 0) + (usage.costUsdEquivalent ?? 0),
          tokens: (context.sessionBefore?.tokens ?? 0) + totalTokens(usage),
        };
      } else if (resumed && state.thread.sessionId !== null) {
        context.prompt = `Continue the current task from where it stopped. The user changed the permission mode to ${permissions.mode}. Do not repeat completed work. Retain subsequent instructions already in the conversation.\n\nRequest for reference:\n${context.prompt}`;
        if (usage) context.sessionBefore = {
          costUsd: (context.sessionBefore?.costUsd ?? 0) + (usage.costUsdEquivalent ?? 0),
          tokens: (context.sessionBefore?.tokens ?? 0) + totalTokens(usage),
        };
      }
      if (state.running.execution) state.running.execution = { ...state.running.execution, permissionMode: permissions.mode };
      this.core.journal.putTurn(state.running);
      const handle = driver.startTurn(context);
      this.handles.set(threadId, handle);
      permissions.attach(handle);
      const settings = this.liveSettings.get(threadId)?.settings;
      settings?.attach(handle);
      const forced = Promise.withResolvers<TurnResult>();
      this.stopDeadlines.set(threadId, { handle, forced, timer: null });
      // A turn that starts while its agent waits to update pauses at its first tool boundary too.
      if (this.core.updates.wantsPause(provider.id)) this.pauseWanted.set(threadId, provider.id);
      if (!resumed && !retriedLostSession && !queued.execution?.operation) this.threads.titles.autoTitle(threadId, turnId);
      result = await Promise.race([handle.done, forced.promise]);
      permissions.detach();
      settings?.detach();
      await permissions.settled();
      await settings?.settled();
      const deadline = this.stopDeadlines.get(threadId);
      if (deadline?.timer) clearTimeout(deadline.timer);
      const fresh = !retriedLostSession && result.sessionLost === true ? this.dropLostSession(state.thread, result) : null;
      if (this.stopRequested.has(threadId)) {
        result = { ...result, status: 'stopped', ...(fresh ? { error: undefined } : {}) };
        break;
      }
      if (fresh !== null && result.status === 'error') {
        state.thread = fresh;
        retriedLostSession = true;
        state.running = { ...state.running, ...(state.running.execution ? { execution: { ...state.running.execution, sessionId: null, sessionGeneration: fresh.sessionGeneration ?? 0 } } : {}) };
        continue;
      }
      // Stopped between two tool calls for an agent update: the same turn
      // waits for it, then goes on in the same session.
      if (this.pausing.delete(threadId) && result.status === 'stopped') {
        usage = sumUsage(usage, result.usage);
        this.keepSession(state, result);
        const resume = await this.pause(threadId, turnId, provider);
        if (resume === null) {
          result = { status: 'stopped', sessionId: state.thread.sessionId, usage: null };
          break;
        }
        afterUpdate = resume;
        resumed = true;
        continue;
      }
      if (!permissions.restarting || result.status === 'done') break;
      usage = sumUsage(usage, result.usage);
      this.keepSession(state, result);
      this.threads.cards.clearPermissionsOf(threadId);
      this.threads.cards.clearQuestionsOf(threadId);
      setThreadStatus(this.core, threadId, 'running');
      resumed = true;
    }
    result = { ...result, usage: sumUsage(usage, result.usage) };
    if (state.running.execution) state.running.execution = { ...state.running.execution, permissionMode: state.thread.permissionMode };
    return result;
  }

  close(threadId: ThreadId): void {
    this.livePermissions.get(threadId)?.detach();
    this.livePermissions.delete(threadId);
    this.liveSettings.get(threadId)?.settings.detach();
    this.liveSettings.delete(threadId);
    this.handles.delete(threadId);
    const deadline = this.stopDeadlines.get(threadId);
    if (deadline?.timer) clearTimeout(deadline.timer);
    this.stopDeadlines.delete(threadId);
    this.stopRequested.delete(threadId);
    this.preparing.delete(threadId);
    this.pauseWanted.delete(threadId);
    this.pausing.delete(threadId);
    this.paused.delete(threadId);
  }

  /** The session a stopped attempt leaves goes on the thread, so a later stop keeps it too. */
  private keepSession(state: TurnAttemptState, result: TurnResult): void {
    state.thread = { ...state.thread, sessionId: result.sessionId ?? state.thread.sessionId, sessionResumeAt: null };
    if (state.running.execution) state.running = { ...state.running, execution: { ...state.running.execution, sessionId: state.thread.sessionId, sessionResumeAt: null } };
    const current = this.core.journal.getThread(state.threadId);
    if (current && (current.sessionGeneration ?? 0) === (state.thread.sessionGeneration ?? 0)) {
      saveThread(this.core, { ...current, sessionId: state.thread.sessionId, sessionResumeAt: null }, 'thread.updated');
    }
  }

  /** Asks a running turn of this provider to pause at its next tool boundary. False when the thread runs no turn. */
  requestPause(threadId: ThreadId, providerId: ProviderId): boolean {
    if (this.paused.has(threadId) || this.pausing.has(threadId)) return true;
    if (!this.handles.has(threadId)) return false;
    this.pauseWanted.set(threadId, providerId);
    this.toolBoundary(threadId);
    return true;
  }

  /** Withdraws a pause not yet taken. A turn already paused waits for its resume. */
  cancelPause(threadId: ThreadId): void {
    this.pauseWanted.delete(threadId);
  }

  isPaused(threadId: ThreadId): boolean {
    return this.paused.has(threadId);
  }

  /**
   * A turn an agent update waits for pauses once no tool call of it runs and
   * no card waits for the user: when its last tool call ends, or at once when
   * it is asked between two of them. The stop goes out on the next tick,
   * outside the driver's own callback.
   */
  private toolBoundary(threadId: ThreadId): void {
    if (!this.pauseWanted.has(threadId) || this.threads.handoff.toolsRunning(threadId) > 0) return;
    const handle = this.handles.get(threadId);
    if (handle === undefined) return;
    setTimeout(() => {
      if (this.handles.get(threadId) !== handle || !this.pauseWanted.has(threadId) || this.threads.handoff.toolsRunning(threadId) > 0) return;
      if (this.threads.cards.listPermissions(threadId).length > 0 || this.threads.cards.listQuestions(threadId).some((question) => !question.async)) return;
      this.pauseWanted.delete(threadId);
      this.pausing.add(threadId);
      handle.stop();
      this.armStopDeadline(threadId, handle);
    }, 0);
  }

  /**
   * Holds a paused turn until its agent's update settles. Returns what to tell
   * the agent when it goes on, or null when the turn was stopped meanwhile.
   */
  private async pause(threadId: ThreadId, turnId: TurnId, provider: ProviderDescriptor): Promise<Resume | null> {
    this.handles.delete(threadId);
    this.threads.handoff.forgetTools(threadId);
    const left = Promise.withResolvers<null>();
    this.paused.set(threadId, () => left.resolve(null));
    this.threads.noteSystem(threadId, turnId, `Paused between two tool calls while ${provider.name} updates.`, `Paused while ${provider.name} updates`, 'turn.pausedForUpdate');
    try {
      // Taken before the update can learn of this pause: it may settle in the same tick.
      const settled = this.core.updates.resumeOf(provider.id);
      this.core.updates.turnPaused(provider.id);
      const resume = await Promise.race([settled, left.promise]);
      return resume === null || this.stopRequested.has(threadId) || this.core.stopping || this.core.journal.isClosed() ? null : resume;
    } finally {
      this.paused.delete(threadId);
    }
  }

  /**
   * The agent no longer has the native session this turn resumed: a Claude
   * transcript past `cleanupPeriodDays`, a deleted Codex rollout, a copied data
   * directory. Keeping the id would fail every prompt of the thread for good,
   * so it goes, and the generation moves on as an account switch does: the
   * next start is fresh and carries the journal's history. Returns the turn's
   * thread snapshot for that fresh start, or null when the thread moved on
   * meanwhile (archived, switched account, or a resident agent's session).
   */
  private dropLostSession(thread: ThreadSummary, result: TurnResult): ThreadSummary | null {
    if (thread.agentSessionId || thread.sessionId === null) return null;
    const current = this.core.journal.getThread(thread.id);
    if (current === null || current.archived) return null;
    if ((current.sessionGeneration ?? 0) !== (thread.sessionGeneration ?? 0) || current.sessionId !== thread.sessionId) return null;
    const generation = (current.sessionGeneration ?? 0) + 1;
    this.core.log('info', `thread ${thread.id}: the agent has no session ${thread.sessionId} any more (${result.diagnosticError ?? result.error ?? 'no reason given'}); starting a fresh one with the thread's history`);
    saveThread(this.core, { ...current, sessionId: null, sessionResumeAt: null, sessionGeneration: generation, context: null, promptCache: null }, 'thread.updated');
    return { ...thread, sessionId: null, sessionResumeAt: null, sessionGeneration: generation, context: null, promptCache: null };
  }

  stopRunning(threadId: ThreadId): boolean {
    const paused = this.paused.get(threadId);
    if (paused !== undefined) {
      this.stopRequested.add(threadId);
      paused();
      return true;
    }
    this.pauseWanted.delete(threadId);
    const handle = this.handles.get(threadId);
    if (handle === undefined) {
      if (!this.preparing.has(threadId)) return false;
      this.stopRequested.add(threadId);
      return true;
    }
    // An open card is what the driver is parked on. Aborting without answering
    // it leaves that await pending for good: the turn never finishes, the
    // thread stays `waiting`, and Stop does nothing the user can see.
    this.threads.cards.clearPermissionsOf(threadId);
    this.threads.cards.clearQuestionsOf(threadId);
    this.stopRequested.add(threadId);
    handle.stop();
    this.armStopDeadline(threadId, handle);
    return true;
  }

  /**
   * A driver whose agent ignores its cancel would leave the thread running for
   * good, its scheduler slot taken and a project removal waiting on it. Kill
   * first: settling the turn alone would leave the driver's session busy, and
   * the next turn would queue behind the wedged one.
   */
  private armStopDeadline(threadId: ThreadId, handle: TurnHandle): void {
    const deadline = this.stopDeadlines.get(threadId);
    if (deadline === undefined || deadline.handle !== handle || deadline.timer !== null) return;
    deadline.timer = setTimeout(() => {
      if (this.handles.get(threadId) !== handle) return;
      this.core.log('warn', `thread ${threadId} did not stop within ${STOP_DEADLINE.ms} ms: ending its processes`);
      this.core.procs.killTree(threadId);
      releaseThread(threadId);
      deadline.timer = setTimeout(() => {
        if (this.handles.get(threadId) !== handle) return;
        const thread = this.core.journal.getThread(threadId);
        deadline.forced.resolve({ status: 'stopped', sessionId: thread?.sessionId ?? null, usage: null, error: STOP_DEADLINE_ERROR });
      }, STOP_DEADLINE.forceMs);
      deadline.timer.unref?.();
    }, STOP_DEADLINE.ms);
    deadline.timer.unref?.();
  }
}

/** Native attempts belong to one visible turn, including their reported usage. */
function sumUsage(left: Usage | null, right: Usage | null): Usage | null {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsdEquivalent: left.costUsdEquivalent === null && right.costUsdEquivalent === null ? null : (left.costUsdEquivalent ?? 0) + (right.costUsdEquivalent ?? 0),
  };
}
