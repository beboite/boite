import type { Account, MessageId, PermissionMode, ProviderDescriptor, ProviderId, RpcEvents, ThreadId, ThreadRetry, ThreadSummary, Turn, TurnId, Usage } from '@boite/contracts';
import type { Core } from '../core.ts';
import { assertDriverRunnable, releaseThread } from '../drivers/index.ts';
import type { Driver, TurnContext, TurnHandle, TurnResult } from '../drivers/types.ts';
import type { Resume } from '../providers/update-resume.ts';
import type { ThreadStore } from '../threads.ts';
import { sumUsage, totalTokens } from '../usage.ts';
import { LivePermissions } from './live-permissions.ts';
import { LiveSettings } from './live-settings.ts';
import { saveThread, withLoad } from './records.ts';
import { markRunning } from './lifecycle.ts';
import { RESUME_TEXT, modeRestartPrompt } from './resume-text.ts';
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

/**
 * How long a turn the provider refused at capacity waits before each new try:
 * three tries, after 30 s, 2 min and 5 min. Mutable so a test can shorten it.
 */
export const CAPACITY_RETRY = { delaysMs: [30_000, 120_000, 300_000] };
/** What a try after capacity sends when the attempt before it had already written something. */
export const CAPACITY_CONTINUE_PROMPT = RESUME_TEXT.capacity.prompt;

type RetryOutcome = 'retry' | 'stop' | 'cancel';

interface StopDeadline {
  handle: TurnHandle;
  forced: { promise: Promise<TurnResult>; resolve: (result: TurnResult) => void };
  timer: ReturnType<typeof setTimeout> | null;
}

/** Native attempts and their active controls belong to one visible turn. */
export class TurnAttempts {
  readonly handles = new Map<ThreadId, TurnHandle>();
  readonly #livePermissions = new Map<ThreadId, LivePermissions>();
  readonly #liveSettings = new Map<ThreadId, { state: TurnAttemptState; settings: LiveSettings }>();
  /** Per running turn: what settles it when its driver never answers a stop. */
  readonly #stopDeadlines = new Map<ThreadId, StopDeadline>();
  /** Threads whose running turn the user stopped: a lost session is not retried for them. */
  readonly #stopRequested = new Set<ThreadId>();
  readonly #preparing = new Set<ThreadId>();
  /** Turns an agent update asked to pause at their next tool boundary. */
  readonly #pauseWanted = new Map<ThreadId, ProviderId>();
  /** Turns whose driver was stopped to pause them, not by the user, by the provider they pause for. */
  readonly #pausing = new Map<ThreadId, ProviderId>();
  /** Paused turns: the provider they wait for, and what ends their pause early, a stop or the core closing. */
  readonly #paused = new Map<ThreadId, { providerId: ProviderId; leave: () => void }>();
  /** Turns waiting to try again after the model was at capacity, and what ends the wait. */
  readonly #retryWaits = new Map<ThreadId, { retry: ThreadRetry; leave: (outcome: RetryOutcome) => void }>();

  readonly #core: Core;

  constructor(core: Core, private readonly threads: ThreadStore) {
    this.#core = core;
    core.bus.onAny((name, payload) => {
      if (name === 'turn.toolCompleted') this.#toolBoundary((payload as RpcEvents['turn.toolCompleted']).threadId);
    });
  }

  open(state: TurnAttemptState): LivePermissions {
    const { threadId } = state;
    this.#stopRequested.delete(threadId);
    this.#preparing.add(threadId);
    const permissions = new LivePermissions(state.thread.permissionMode, handle => {
      this.threads.cards.clearPermissionsOf(threadId, 'mode change');
      this.threads.cards.clearQuestionsOf(threadId, false, 'mode change');
      handle.stop();
      this.#armStopDeadline(threadId, handle);
    }, mode => {
      state.thread.permissionMode = mode;
      if (state.running.execution) state.running.execution = { ...state.running.execution, permissionMode: mode };
      this.#core.journal.putTurn(state.running);
      this.threads.cards.applyPermissionMode(threadId, mode);
    });
    this.#livePermissions.set(threadId, permissions);
    const settings = new LiveSettings(() => ({ effort: state.thread.effort, speed: state.thread.speed ?? null }), taken => {
      state.thread = { ...state.thread, ...taken };
      if (state.running.execution) state.running.execution = { ...state.running.execution, ...taken };
      this.#core.journal.putTurn(state.running);
    });
    this.#liveSettings.set(threadId, { state, settings });
    return permissions;
  }

  /**
   * The thread's effort or speed moved while its turn runs. They only mean
   * something on the model the turn started on: a selection that also changed
   * the model or the account waits for the next turn whole.
   */
  changeSettings(threadId: ThreadId, selection: Pick<ThreadSummary, 'accountId' | 'model' | 'effort' | 'speed'>): void {
    const live = this.#liveSettings.get(threadId);
    if (live === undefined) return;
    if (live.state.running.execution?.frozenSelection) return;
    if (selection.accountId !== live.state.thread.accountId || selection.model !== live.state.thread.model) return;
    live.settings.change({ effort: selection.effort, speed: selection.speed ?? null });
  }

  changePermissionMode(threadId: ThreadId, mode: PermissionMode, before: ThreadSummary, next: ThreadSummary): void {
    const state = this.#liveSettings.get(threadId)?.state;
    const modeOnly = before.providerId === next.providerId && before.accountId === next.accountId && before.model === next.model
      && before.effort === next.effort && (before.speed ?? null) === (next.speed ?? null);
    const permissions = this.#livePermissions.get(threadId);
    if (!permissions) {
      // Queued turns have no native controller yet. Retain only an unbroken
      // mode-only version chain; startup will pass the live mode to the driver.
      if (modeOnly) for (const turn of this.#core.journal.listTurnsFor(threadId, [])) {
        if (turn.status !== 'queued' || !turn.execution || (turn.execution.selectionVersion ?? 0) !== (before.selectionVersion ?? 0)) continue;
        turn.execution = { ...turn.execution, permissionMode: mode, selectionVersion: next.selectionVersion ?? 0 };
        this.#core.journal.putTurn(turn);
      }
      return;
    }
    permissions.change(mode, () => {
      const execution = state?.running.execution;
      // Mode is live; other picker changes, including a change and return, stay fenced.
      if (!modeOnly || !state || !execution || (execution.selectionVersion ?? 0) !== (before.selectionVersion ?? 0)) return;
      state.thread.selectionVersion = next.selectionVersion;
      state.running.execution = { ...execution, selectionVersion: next.selectionVersion ?? 0 };
      this.#core.journal.putTurn(state.running);
      const current = this.#core.journal.getThread(threadId);
      if (current) this.#core.bus.emit('thread.updated', current);
    });
  }

  async run(queued: Turn, state: TurnAttemptState, target: TurnAttemptTarget, permissions: LivePermissions): Promise<TurnResult> {
    const { threadId, turnId } = state;
    const { provider, driver } = target;
    const accountId = target.account.id;
    if (this.#stopRequested.has(threadId)) return { status: 'stopped', sessionId: state.thread.sessionId, usage: null };
    try {
      const protection = this.#core.sharedAccess.execution.prepare(threadId);
      if (protection) await protection;
      const checkpoint = this.threads.codeCheckpoints.begin(state.thread, turnId);
      if (checkpoint && driver.prepare) {
        const account = this.#core.accounts.require(accountId);
        assertDriverRunnable(provider.protocol, this.#core.providers.summary(provider.id), account);
        const context = this.threads.contexts.makeSessionContext(state.thread, provider, account);
        void driver.prepare(context, { forTurn: true }).catch(error => {
          if (!this.#stopRequested.has(threadId)) this.#core.log('warn', `preparing the turn failed: ${String(error)}`, { source: provider.id, threadId, event: 'provider.prepareFailed' });
        });
      }
      if (checkpoint) await checkpoint;
    } catch (error) {
      releaseThread(threadId);
      void this.#core.procs.protection.revoke(threadId).catch(() => {});
      this.#core.procs.killTree(threadId);
      if (this.#stopRequested.has(threadId)) return { status: 'stopped', sessionId: state.thread.sessionId, usage: null };
      throw error;
    } finally { this.#preparing.delete(threadId); }
    if (this.#stopRequested.has(threadId)) return { status: 'stopped', sessionId: state.thread.sessionId, usage: null };

    // Keep consumed input so a retry on a fresh session sends it too.
    const carried: CarriedInput = {};
    let retriedLostSession = false;
    let resumed = false;
    let usage: Usage | null = null;
    /** The agent's running totals as the last attempt that reported them ended. */
    let totals: TurnResult['agentTotals'] = undefined;
    let result: TurnResult;
    /** What the agent is told when its turn goes on after an agent update. */
    let afterUpdate: Resume | null = null;
    let attempt = 0;
    /** What started the next attempt, set where the loop goes round again. */
    let because = 'first attempt';
    /** Tries already spent on a model at capacity, and whether any attempt of this turn wrote something. */
    let capacityTries = 0;
    let wroteBefore = false;
    let afterCapacity = false;
    for (;;) {
      attempt += 1;
      // A retry or delayed provider preparation cannot outlive shared host consent.
      this.#core.sharedCompute?.assertTurn(threadId);
      this.#core.sharedAccess?.assertTurn(threadId);
      const protection = this.#core.sharedAccess.execution.prepare(threadId);
      if (protection) await protection;
      // Preparation can yield while the user changes modes. Read it only
      // once the native context and handle can be constructed without yielding.
      state.thread.permissionMode = permissions.mode;
      const note = afterUpdate;
      afterUpdate = null;
      // The resumed session already holds what the first attempt took from the thread.
      const continuing = afterCapacity && wroteBefore;
      afterCapacity = false;
      // Preparation, capacity waits and lost-session retries can all outlive an admin edit or sign-out.
      const account = this.#core.accounts.require(accountId);
      const context = this.threads.contexts.makeContext(state.thread, provider, account, state.running, note || continuing ? { memory: '', deferred: '', letters: '' } : carried, note?.prompt);
      // Whether this attempt writes anything but an error: the agent's session then holds work a new try must not repeat.
      let wrote = false;
      const sink = context.emit;
      // While the core hands its turns over, a service manager may signal every agent with it: an agent
      // that dies then reports the restart as its error. That error waits for the attempt's end; one the
      // agent writes past (a pi error notice) did not end it and goes out then. Redrawing an earlier part
      // (Codex settles its running tools after its failure) is not going on.
      const held: { errors: Parameters<TurnContext['emit']['part']>[]; failed: MessageId[] } = { errors: [], failed: [] };
      const release = (messageId: MessageId | null, partIndex: number): void => {
        if (!held.errors.some(([at, index]) => messageId === null || at !== messageId || partIndex > index)) return;
        for (const args of held.errors.splice(0)) sink.part(...args);
        for (const failed of held.failed.splice(0)) sink.complete(failed, 'error');
      };
      context.emit = {
        startMessage: role => { release(null, 0); return sink.startMessage(role); },
        delta: (messageId, partIndex, text) => { release(messageId, partIndex); wrote = true; sink.delta(messageId, partIndex, text); },
        part: (messageId, partIndex, part) => {
          if (part.type === 'error' && this.threads.handoff.active) { held.errors.push([messageId, partIndex, part]); return; }
          release(messageId, partIndex);
          if (part.type !== 'error') wrote = true;
          sink.part(messageId, partIndex, part);
        },
        // A patch changes a tool part already written.
        patchTool: (messageId, partIndex, fields) => sink.patchTool(messageId, partIndex, fields),
        complete: (messageId, messageState) => {
          if (messageState === 'error' && held.errors.length > 0) { held.failed.push(messageId); return; }
          sink.complete(messageId, messageState);
        },
      };
      if (continuing) {
        // The native session already holds the request and what the agent did with it.
        context.prompt = CAPACITY_CONTINUE_PROMPT;
        context.attachments = [];
      } else if (note) {
        // Shown once the context is built, so a fresh session's history does not carry it twice.
        this.threads.noteSystem(threadId, turnId, note.prompt, note.label, 'turn.resumedAfterUpdate');
      } else if (resumed && state.thread.sessionId !== null) {
        context.prompt = modeRestartPrompt(permissions.mode, context.prompt);
      }
      // A later attempt resumes a session that already holds the earlier ones, refused or not.
      if (attempt > 1 && state.thread.sessionId !== null) context.sessionBefore = sessionAfter(context.sessionBefore, usage, totals);
      if (state.running.execution) state.running.execution = { ...state.running.execution, permissionMode: permissions.mode };
      this.#core.journal.putTurn(state.running);
      const attemptAt = performance.now();
      const why = because;
      quiet(() => this.#core.logs.info(`Attempt ${attempt} (${why}) on ${provider.id} ${state.thread.model ?? 'default model'}, ${state.thread.sessionId === null ? 'new session' : 'resuming session'}, permission mode ${permissions.mode}`, {
        source: 'turns', event: 'turn.attempt.started', threadId, turnId, providerId: provider.id, ...(state.thread.model ? { model: state.thread.model } : {}),
        data: { attempt, why, protocol: provider.protocol, accountId: account.id, resume: state.thread.sessionId !== null, permissionMode: permissions.mode, effort: state.thread.effort ?? null, speed: state.thread.speed ?? null },
      }));
      assertDriverRunnable(provider.protocol, this.#core.providers.summary(provider.id), account);
      const handle = driver.startTurn(context);
      this.handles.set(threadId, handle);
      this.#core.composer.inputReady(threadId);
      permissions.attach(handle);
      const settings = this.#liveSettings.get(threadId)?.settings;
      settings?.attach(handle);
      const forced = Promise.withResolvers<TurnResult>();
      this.#stopDeadlines.set(threadId, { handle, forced, timer: null });
      // A turn that starts while its agent waits to update pauses at its first tool boundary too.
      if (this.#core.updates.wantsPause(provider.id)) this.#pauseWanted.set(threadId, provider.id);
      if (!resumed && !retriedLostSession && capacityTries === 0 && !queued.execution?.operation) this.threads.titles.autoTitle(threadId, turnId);
      result = await Promise.race([handle.done, forced.promise]);
      totals = result.agentTotals ?? totals;
      logAttemptEnd(this.#core, threadId, turnId, attempt, result, performance.now() - attemptAt);
      permissions.detach();
      settings?.detach();
      await permissions.settled();
      await settings?.settled();
      const deadline = this.#stopDeadlines.get(threadId);
      if (deadline?.timer) clearTimeout(deadline.timer);
      const fresh = !retriedLostSession && result.sessionLost === true ? this.#dropLostSession(state.thread, result) : null;
      // Cut by the restart: a stop the next core resumes, not a failure. A refusal stays one.
      const cut = result.status === 'error' && result.refusal === undefined && this.threads.handoff.active;
      const stopped = cut || this.#stopRequested.has(threadId);
      // Only the death that cut the attempt is dropped; anything else held goes out as the agent wrote it.
      // Drained: a later attempt writes through this wrapper too, and must not release them again.
      for (const args of held.errors.splice(0)) if (!cut) sink.part(...args);
      for (const messageId of held.failed.splice(0)) sink.complete(messageId, cut ? 'complete' : 'error');
      if (stopped) {
        result = { ...result, status: 'stopped', ...(fresh || cut ? { error: undefined } : {}) };
        break;
      }
      // A keepalive on a fresh session would write the whole history to warm nothing: it fails, and the wait ends.
      if (fresh !== null && result.status === 'error' && queued.execution?.operation !== 'keepalive') {
        state.thread = fresh;
        retriedLostSession = true;
        totals = undefined;
        state.running = { ...state.running, ...(state.running.execution ? { execution: { ...state.running.execution, sessionId: null, sessionGeneration: fresh.sessionGeneration ?? 0 } } : {}) };
        because = 'retry on a fresh session';
        continue;
      }
      wroteBefore ||= wrote;
      // The model was at capacity: the same turn tries again later, in the
      // same native session. Nothing written yet: the same input goes again.
      // Something written: a short continue prompt, so paid work is not redone.
      if (result.status === 'error' && result.refusal?.kind === 'capacity' && capacityTries < CAPACITY_RETRY.delaysMs.length && !this.#core.stopping) {
        const delay = CAPACITY_RETRY.delaysMs[capacityTries]!;
        capacityTries += 1;
        usage = sumAttempts(usage, result.usage);
        this.#keepSession(state, result);
        const outcome = await this.#waitToRetry(state, capacityTries, delay, provider);
        if (outcome === 'stop') {
          result = { status: 'stopped', sessionId: state.thread.sessionId, usage: null };
          break;
        }
        if (outcome === 'cancel') {
          // Its usage is counted above already.
          result = { ...result, usage: null };
          break;
        }
        markRunning(this.#core, threadId);
        afterCapacity = true;
        because = `retry ${capacityTries} of ${CAPACITY_RETRY.delaysMs.length} after the model was at capacity`;
        continue;
      }
      // Stopped between two tool calls for an agent update: the same turn
      // waits for it, then goes on in the same session.
      if (this.#pausing.delete(threadId) && result.status === 'stopped') {
        usage = sumAttempts(usage, result.usage);
        this.#keepSession(state, result);
        const resume = await this.#pause(threadId, turnId, provider);
        if (resume === null) {
          result = { status: 'stopped', sessionId: state.thread.sessionId, usage: null };
          break;
        }
        afterUpdate = resume;
        resumed = true;
        because = 'after an agent update';
        continue;
      }
      if (!permissions.restarting || result.status === 'done') break;
      usage = sumAttempts(usage, result.usage);
      this.#keepSession(state, result);
      this.threads.cards.clearPermissionsOf(threadId, 'mode change');
      this.threads.cards.clearQuestionsOf(threadId, false, 'mode change');
      markRunning(this.#core, threadId);
      resumed = true;
      because = 'after a permission mode change';
    }
    // The drivers hand over canonical buckets: the turn records that it holds them.
    const spent = sumAttempts(usage, result.usage);
    result = { ...result, usage: spent === null ? null : { ...spent, buckets: 1 }, ...(totals ? { agentTotals: totals } : {}) };
    if (state.running.execution) state.running.execution = { ...state.running.execution, permissionMode: state.thread.permissionMode };
    return result;
  }

  /** A preparation process killed by an accepted Stop can reject before run starts. */
  preparationStopped(threadId: ThreadId): boolean {
    return this.#preparing.has(threadId) && this.#stopRequested.has(threadId);
  }

  close(threadId: ThreadId): void {
    this.#livePermissions.get(threadId)?.detach();
    this.#livePermissions.delete(threadId);
    this.#liveSettings.get(threadId)?.settings.detach();
    this.#liveSettings.delete(threadId);
    this.handles.delete(threadId);
    const deadline = this.#stopDeadlines.get(threadId);
    if (deadline?.timer) clearTimeout(deadline.timer);
    this.#stopDeadlines.delete(threadId);
    this.#stopRequested.delete(threadId);
    this.#preparing.delete(threadId);
    this.#pauseWanted.delete(threadId);
    this.#pausing.delete(threadId);
    this.#paused.delete(threadId);
    this.#retryWaits.get(threadId)?.leave('stop');
    this.#retryWaits.delete(threadId);
  }

  /** The capacity retry a turn of this thread waits for, or null. */
  retryOf(threadId: ThreadId): ThreadRetry | null {
    return this.#retryWaits.get(threadId)?.retry ?? null;
  }

  /** Gives up the capacity retry the thread waits for: its turn fails with the refusal. False when none waits. */
  cancelRetry(threadId: ThreadId): boolean {
    const wait = this.#retryWaits.get(threadId);
    if (wait === undefined) return false;
    wait.leave('cancel');
    return true;
  }

  /**
   * Holds a turn the model refused at capacity until its next try. The thread
   * stays running and shows the try and its time (`ThreadSummary.retry`); a
   * stop, a cancel or the core closing ends the wait early.
   */
  async #waitToRetry(state: TurnAttemptState, attempt: number, delayMs: number, provider: ProviderDescriptor): Promise<RetryOutcome> {
    const { threadId, turnId } = state;
    this.handles.delete(threadId);
    this.threads.handoff.forgetTools(threadId);
    const retry: ThreadRetry = { kind: 'capacity', turnId, at: Date.now() + delayMs, attempt, attempts: CAPACITY_RETRY.delaysMs.length, resetsAt: null };
    const left = Promise.withResolvers<RetryOutcome>();
    const timer = setTimeout(() => left.resolve('retry'), delayMs);
    timer.unref?.();
    this.#retryWaits.set(threadId, { retry, leave: outcome => left.resolve(outcome) });
    quiet(() => this.#core.logs.info(`${provider.name} refused the turn at capacity; try ${attempt} of ${retry.attempts} in ${Math.round(delayMs / 1000)} s`, {
      source: 'turns', event: 'turn.capacity-retry.waiting', threadId, turnId, providerId: provider.id, data: { attempt, attempts: retry.attempts, delayMs },
    }));
    this.#announce(threadId);
    try {
      const outcome = await left.promise;
      const final = this.#stopRequested.has(threadId) || this.#core.stopping || this.#core.journal.isClosed() ? 'stop' : outcome;
      quiet(() => this.#core.logs.info(final === 'retry' ? `Capacity retry ${attempt} starts` : `Capacity retry ${attempt} ${final === 'stop' ? 'ended by a stop' : 'cancelled'}`, {
        source: 'turns', event: 'turn.capacity-retry.ended', threadId, turnId, data: { attempt, outcome: final },
      }));
      return final;
    } finally {
      clearTimeout(timer);
      if (this.#retryWaits.get(threadId)?.retry === retry) this.#retryWaits.delete(threadId);
      this.#announce(threadId);
    }
  }

  /** Tells every client the thread's row changed: its planned retry came or went. */
  #announce(threadId: ThreadId): void {
    if (this.#core.journal.isClosed()) return;
    const thread = this.#core.journal.getThread(threadId);
    if (thread !== null) quiet(() => this.#core.bus.emit('thread.updated', withLoad(this.#core, thread)));
  }

  /** The session a stopped attempt leaves goes on the thread, so a later stop keeps it too. */
  #keepSession(state: TurnAttemptState, result: TurnResult): void {
    state.thread = { ...state.thread, sessionId: result.sessionId ?? state.thread.sessionId, sessionResumeAt: null };
    if (state.running.execution) state.running = { ...state.running, execution: { ...state.running.execution, sessionId: state.thread.sessionId, sessionResumeAt: null } };
    const current = this.#core.journal.getThread(state.threadId);
    if (current && current.providerId === state.thread.providerId && current.accountId === state.thread.accountId && (current.sessionGeneration ?? 0) === (state.thread.sessionGeneration ?? 0)) {
      saveThread(this.#core, { ...current, sessionId: state.thread.sessionId, sessionResumeAt: null }, 'thread.updated');
    }
  }

  /** Asks a running turn of this provider to pause at its next tool boundary. False when the thread runs no turn. */
  requestPause(threadId: ThreadId, providerId: ProviderId): boolean {
    // A pause already taken counts only for the provider it was taken for.
    const taken = this.#pausing.get(threadId) ?? this.#paused.get(threadId)?.providerId;
    if (taken !== undefined) return taken === providerId;
    if (!this.handles.has(threadId)) return false;
    this.#pauseWanted.set(threadId, providerId);
    this.#toolBoundary(threadId);
    return true;
  }

  /** Withdraws a pause not yet taken. A turn already paused waits for its resume. */
  cancelPause(threadId: ThreadId): void {
    this.#pauseWanted.delete(threadId);
  }

  isPaused(threadId: ThreadId): boolean {
    return this.#paused.has(threadId);
  }

  /**
   * A turn an agent update waits for pauses once no tool call of it runs and
   * no card waits for the user: when its last tool call ends, or at once when
   * it is asked between two of them. The stop goes out on the next tick,
   * outside the driver's own callback.
   */
  #toolBoundary(threadId: ThreadId): void {
    const providerId = this.#pauseWanted.get(threadId);
    if (providerId === undefined || this.threads.handoff.toolsRunning(threadId) > 0) return;
    // The update may have run or stopped pausing since it asked: nothing to pause for any more.
    if (!this.#core.updates.wantsPause(providerId)) {
      this.#pauseWanted.delete(threadId);
      return;
    }
    const handle = this.handles.get(threadId);
    if (handle === undefined) return;
    setTimeout(() => {
      if (this.handles.get(threadId) !== handle || !this.#pauseWanted.has(threadId) || this.threads.handoff.toolsRunning(threadId) > 0) return;
      if (this.threads.cards.listPermissions(threadId).length > 0 || this.threads.cards.listQuestions(threadId).some((question) => !question.async)) return;
      this.#pauseWanted.delete(threadId);
      this.#pausing.set(threadId, providerId);
      handle.stop();
      this.#armStopDeadline(threadId, handle);
    }, 0);
  }

  /**
   * Holds a paused turn until its agent's update settles. Returns what to tell
   * the agent when it goes on, or null when the turn was stopped meanwhile.
   */
  async #pause(threadId: ThreadId, turnId: TurnId, provider: ProviderDescriptor): Promise<Resume | null> {
    this.handles.delete(threadId);
    this.threads.handoff.forgetTools(threadId);
    const left = Promise.withResolvers<null>();
    this.#paused.set(threadId, { providerId: provider.id, leave: () => left.resolve(null) });
    const pausedAt = performance.now();
    quiet(() => this.#core.logs.info(`Turn paused between two tool calls while ${provider.id} updates`, { source: 'turns', event: 'turn.paused-for-update', threadId, turnId }));
    this.threads.noteSystem(threadId, turnId, `Paused between two tool calls while ${provider.name} updates.`, `Paused while ${provider.name} updates`, 'turn.pausedForUpdate');
    try {
      // Taken before the update can learn of this pause: it may settle in the same tick.
      const settled = this.#core.updates.resumeOf(provider.id, threadId);
      this.#core.updates.turnPaused(provider.id);
      const resume = await Promise.race([settled, left.promise]);
      quiet(() => this.#core.logs.info(resume === null ? 'Turn paused for an update was stopped before the update ended' : `Turn resumes after ${provider.id} updated`, {
        source: 'turns', event: 'turn.resumed-after-update', threadId, turnId, durationMs: performance.now() - pausedAt, data: { resumed: resume !== null },
      }));
      return resume === null || this.#stopRequested.has(threadId) || this.#core.stopping || this.#core.journal.isClosed() ? null : resume;
    } finally {
      this.#paused.delete(threadId);
    }
  }

  /**
   * The agent no longer has the native session this turn resumed: a Claude
   * transcript past `cleanupPeriodDays`, a deleted Codex rollout, a copied data
   * directory. Keeping the id would fail every prompt of the thread for good,
   * so it goes, and the generation moves on as an account switch does: the
   * next start is fresh and carries the journal's history. Returns the turn's
   * thread snapshot for that fresh start, or null when the thread moved on
   * meanwhile (archived or switched account).
   */
  #dropLostSession(thread: ThreadSummary, result: TurnResult): ThreadSummary | null {
    if (thread.sessionId === null) return null;
    const current = this.#core.journal.getThread(thread.id);
    if (current === null || current.archived) return null;
    if ((current.sessionGeneration ?? 0) !== (thread.sessionGeneration ?? 0) || current.sessionId !== thread.sessionId) return null;
    const generation = (current.sessionGeneration ?? 0) + 1;
    this.#core.log('info', `thread ${thread.id}: the agent has no session ${thread.sessionId} any more (${result.diagnosticError ?? result.error ?? 'no reason given'}); starting a fresh one with the thread's history`, { source: 'turns', event: 'turn.session-lost', threadId: thread.id, data: { sessionGeneration: generation } });
    saveThread(this.#core, { ...current, sessionId: null, sessionResumeAt: null, sessionGeneration: generation, context: null, promptCache: null }, 'thread.updated');
    return { ...thread, sessionId: null, sessionResumeAt: null, sessionGeneration: generation, context: null, promptCache: null };
  }

  stopRunning(threadId: ThreadId): boolean {
    void this.#core.procs.protection.revoke(threadId).catch(() => {});
    const waiting = this.#retryWaits.get(threadId);
    if (waiting !== undefined) {
      this.#stopRequested.add(threadId);
      waiting.leave('stop');
      return true;
    }
    const paused = this.#paused.get(threadId);
    if (paused !== undefined) {
      this.#stopRequested.add(threadId);
      paused.leave();
      return true;
    }
    this.#pauseWanted.delete(threadId);
    const handle = this.handles.get(threadId);
    if (handle === undefined) {
      if (!this.#preparing.has(threadId)) return false;
      this.#stopRequested.add(threadId);
      releaseThread(threadId);
      this.#core.procs.killTree(threadId);
      return true;
    }
    // An open card is what the driver is parked on. Aborting without answering
    // it leaves that await pending for good: the turn never finishes, the
    // thread stays `waiting`, and Stop does nothing the user can see.
    this.threads.cards.clearPermissionsOf(threadId, 'stop');
    this.threads.cards.clearQuestionsOf(threadId, false, 'stop');
    this.#stopRequested.add(threadId);
    handle.stop();
    this.#armStopDeadline(threadId, handle);
    return true;
  }

  /**
   * A driver whose agent ignores its cancel would leave the thread running for
   * good, its scheduler slot taken and a project removal waiting on it. Kill
   * first: settling the turn alone would leave the driver's session busy, and
   * the next turn would queue behind the wedged one.
   */
  #armStopDeadline(threadId: ThreadId, handle: TurnHandle): void {
    const deadline = this.#stopDeadlines.get(threadId);
    if (deadline === undefined || deadline.handle !== handle || deadline.timer !== null) return;
    deadline.timer = setTimeout(() => {
      if (this.handles.get(threadId) !== handle) return;
      this.#core.log('warn', `thread ${threadId} did not stop within ${STOP_DEADLINE.ms} ms: ending its processes`, { source: 'turns', event: 'turn.stop-deadline', threadId, data: { deadlineMs: STOP_DEADLINE.ms } });
      this.#core.procs.killTree(threadId);
      releaseThread(threadId);
      deadline.timer = setTimeout(() => {
        if (this.handles.get(threadId) !== handle) return;
        const thread = this.#core.journal.getThread(threadId);
        deadline.forced.resolve({ status: 'stopped', sessionId: thread?.sessionId ?? null, usage: null, error: STOP_DEADLINE_ERROR });
      }, STOP_DEADLINE.forceMs);
      deadline.timer.unref?.();
    }, STOP_DEADLINE.ms);
    deadline.timer.unref?.();
  }
}

/** One line per driver attempt: how it ended and, for a failure, the cause the driver gave. */
function logAttemptEnd(core: Core, threadId: ThreadId, turnId: TurnId, attempt: number, result: TurnResult, ms: number): void {
  const cause = result.status === 'error' ? `: ${result.diagnosticError ?? result.error ?? 'no reason given'}` : '';
  quiet(() => core.logs.record(result.status === 'error' ? 'warn' : 'info', `Attempt ${attempt} ended ${result.status} after ${Math.round(ms / 100) / 10} s${result.sessionLost ? ', the agent lost its session' : ''}${cause}`, {
    source: 'turns', event: 'turn.attempt.finished', threadId, turnId, durationMs: ms,
    data: { attempt, status: result.status, sessionLost: result.sessionLost === true, ...(result.usage ? { outputTokens: result.usage.outputTokens } : {}) },
  }));
}

/** A diagnostic storage failure must not break a turn: its result, its retries or its pause. */
function quiet(write: () => void): void {
  try { write(); } catch { /* the turn goes on without the record */ }
}

/**
 * What the session holds once an earlier attempt of the same turn ended. An
 * agent that restores its own totals resumes from the ones that attempt
 * reported; otherwise its usage adds to what the earlier turns used.
 */
function sessionAfter(before: TurnContext['sessionBefore'], usage: Usage | null, totals: TurnResult['agentTotals']): TurnContext['sessionBefore'] {
  if (totals) return totals;
  if (!usage) return before;
  return { costUsd: (before?.costUsd ?? 0) + (usage.costUsdEquivalent ?? 0), tokens: (before?.tokens ?? 0) + totalTokens(usage) };
}

/** Native attempts belong to one visible turn, including their reported usage. */
function sumAttempts(left: Usage | null, right: Usage | null): Usage | null {
  if (!left) return right;
  if (!right) return left;
  return sumUsage(left, right);
}
