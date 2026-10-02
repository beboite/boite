import type { Account, PermissionMode, ProviderDescriptor, ThreadId, ThreadSummary, Turn, TurnId, Usage } from '@boite/contracts';
import type { Core } from '../core.ts';
import { releaseThread } from '../drivers/index.ts';
import type { Driver, TurnHandle, TurnResult } from '../drivers/types.ts';
import type { ThreadStore } from '../threads.ts';
import { totalTokens } from '../usage.ts';
import { LivePermissions } from './live-permissions.ts';
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
  /** Per running turn: what settles it when its driver never answers a stop. */
  private readonly stopDeadlines = new Map<ThreadId, StopDeadline>();
  /** Threads whose running turn the user stopped: a lost session is not retried for them. */
  private readonly stopRequested = new Set<ThreadId>();
  private readonly preparing = new Set<ThreadId>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

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
    return permissions;
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
    for (;;) {
      state.thread.permissionMode = permissions.mode;
      const context = this.threads.contexts.makeContext(state.thread, provider, account, state.running, carried);
      if (resumed && state.thread.sessionId !== null) {
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
      const forced = Promise.withResolvers<TurnResult>();
      this.stopDeadlines.set(threadId, { handle, forced, timer: null });
      if (!resumed && !retriedLostSession && !queued.execution?.operation) this.threads.titles.autoTitle(threadId, turnId);
      result = await Promise.race([handle.done, forced.promise]);
      permissions.detach();
      await permissions.settled();
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
      if (!permissions.restarting || result.status === 'done') break;
      usage = sumUsage(usage, result.usage);
      state.thread = { ...state.thread, sessionId: result.sessionId ?? state.thread.sessionId, sessionResumeAt: null };
      const current = this.core.journal.getThread(threadId);
      if (current && (current.sessionGeneration ?? 0) === (state.thread.sessionGeneration ?? 0)) {
        saveThread(this.core, { ...current, sessionId: state.thread.sessionId, sessionResumeAt: null }, 'thread.updated');
      }
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
    this.handles.delete(threadId);
    const deadline = this.stopDeadlines.get(threadId);
    if (deadline?.timer) clearTimeout(deadline.timer);
    this.stopDeadlines.delete(threadId);
    this.stopRequested.delete(threadId);
    this.preparing.delete(threadId);
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
