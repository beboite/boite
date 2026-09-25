import type { ThreadId, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { getDriver, releaseThread } from '../drivers/index.ts';
import type { TurnHandle, TurnResult } from '../drivers/types.ts';
import { messageOf } from '../errors.ts';
import { promptCacheOf } from '../prompt-cache.ts';
import type { ThreadStore } from '../threads.ts';
import { saveThread, setThreadStatus } from './records.ts';
import type { CarriedInput } from './turn-context.ts';

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

/**
 * One turn from the scheduler to its end: the driver started and awaited,
 * a lost session retried once on a fresh one, a stop that the agent
 * ignores ended by the deadline, and what the finished turn leaves behind.
 */
export class TurnRunner {
  readonly handles = new Map<ThreadId, TurnHandle>();
  /** Per running turn: what settles it when its driver never answers a stop. */
  private readonly stopDeadlines = new Map<ThreadId, StopDeadline>();
  /** Threads whose running turn the user stopped: a lost session is not retried for them. */
  private readonly stopRequested = new Set<ThreadId>();
  readonly steering = new Set<ThreadId>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  async runTurn(turnId: TurnId, threadId: ThreadId): Promise<void> {
    const queued = this.core.journal.getTurn(turnId);
    const selected = this.core.journal.getThread(threadId);
    if (queued === null || selected === null) return;
    if (!this.core.delegation.prepareTurn(queued)) {
      this.threads.markQueuedStopped(turnId);
      return;
    }
    if (queued.execution?.operation === 'coordination' && !this.core.coordination.prepareWake(threadId, turnId)) {
      this.threads.markQueuedStopped(turnId);
      return;
    }
    let thread = { ...selected, ...queued.execution };

    let running: Turn = { ...queued, status: 'running', startedAt: Date.now() };
    this.core.journal.append({ type: 'turn.started', threadId, version: 1, payload: running }, () => {
      this.core.journal.putTurn(running);
    });
    this.core.bus.emit('turn.started', running);
    setThreadStatus(this.core, threadId, 'running');

    let result: TurnResult;
    try {
      this.core.workforce.resident.assertThreadRoute(threadId, thread);
      const provider = this.core.providers.require(thread.providerId);
      const account = this.core.accounts.require(thread.accountId);
      const driver = getDriver(provider.protocol);
      this.stopRequested.delete(threadId);
      // What building the prompt takes for good (held answers, delegation
      // letters), kept so a retry on a fresh session sends it too.
      const carried: CarriedInput = {};
      const handle = driver.startTurn(this.threads.contexts.makeContext(thread, provider, account, running, carried));
      this.handles.set(threadId, handle);
      const forced = Promise.withResolvers<TurnResult>();
      this.stopDeadlines.set(threadId, { handle, forced, timer: null });
      // A `done` that settles after a forced stop is ignored.
      result = await Promise.race([handle.done, forced.promise]);
      const fresh = result.sessionLost === true ? this.dropLostSession(thread, result) : null;
      if (fresh !== null && result.status === 'error' && this.stopRequested.has(threadId)) {
        // The user stopped a turn whose resume the agent refused: the prompt
        // never reached a model, and the stop stands.
        result = { ...result, status: 'stopped', error: undefined };
      } else if (fresh !== null && result.status === 'error') {
        // Same turn, fresh session: the prompt now carries the journal's history.
        thread = fresh;
        running = { ...running, ...(running.execution ? { execution: { ...running.execution, sessionId: null, sessionGeneration: fresh.sessionGeneration ?? 0 } } : {}) };
        const retry = driver.startTurn(this.threads.contexts.makeContext(thread, provider, account, running, carried));
        this.handles.set(threadId, retry);
        this.stopDeadlines.set(threadId, { handle: retry, forced, timer: null });
        result = await Promise.race([retry.done, forced.promise]);
      }
      if (running.execution?.operation === 'coordination' && result.status === 'done') this.core.coordination.submitted(threadId, turnId);
    } catch (error) {
      result = { status: 'error', sessionId: thread.sessionId, usage: null, error: messageOf(error) };
    } finally {
      this.handles.delete(threadId);
      const deadline = this.stopDeadlines.get(threadId);
      if (deadline?.timer) clearTimeout(deadline.timer);
      this.stopDeadlines.delete(threadId);
      this.stopRequested.delete(threadId);
    }

    if (this.core.journal.isClosed()) return;
    this.core.delegation.submitted(threadId, turnId, result.status === 'done');
    // Writes what the turn streamed to its rows before anything reads them as finished.
    this.core.journal.releaseTurn(turnId);
    this.core.bus.flush();
    this.threads.cards.clearPermissionsOf(threadId);
    this.threads.cards.clearQuestionsOf(threadId);

    const finished: Turn = {
      ...running,
      status: result.status === 'done' ? 'done' : result.status,
      finishedAt: Date.now(),
      usage: result.usage,
      error: result.error ?? null,
    };
    this.core.journal.append({ type: 'turn.finished', threadId, version: 1, payload: finished }, () => {
      this.core.journal.putTurn(finished);
    });
    this.core.bus.emit('turn.finished', finished);

    if (result.status === 'error') {
      this.core.log('error', `turn ${turnId} failed: ${result.error ?? 'unknown error'}`);
    }

    const current = this.core.journal.getThread(threadId);
    if (current === null) return;
    const sameSession = (current.sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0);
    if (current.archived || !sameSession) releaseThread(threadId);
    // A lost session was already forgotten by `dropLostSession` above, which
    // moved the generation on: nothing here bumps it a second time.
    const next: ThreadSummary = {
      ...current,
      sessionId: sameSession ? result.sessionId ?? current.sessionId : current.sessionId,
      status: result.status === 'error' ? 'error' : 'idle',
      unread: current.unread || !this.core.subscribers.hasSubscribers(threadId),
      promptCache: sameSession ? promptCacheOf(result, thread, finished.finishedAt ?? Date.now(), current.promptCache ?? null) ?? current.promptCache ?? null : current.promptCache ?? null,
    };
    saveThread(this.core, next, 'thread.finished');
    if (result.status !== 'done') this.core.coordination.pause(threadId);
    if (result.status === 'done' && sameSession && !queued.execution?.operation) this.threads.titles.autoTitle(threadId, turnId);
    const woke = this.threads.deferred.pendingWakes.get(threadId);
    if (woke !== undefined) {
      this.threads.deferred.pendingWakes.delete(threadId);
      // First, so the output the agent wrote by itself goes before any held answer.
      if (!next.archived) setTimeout(() => this.threads.deferred.wake(threadId, woke), 0);
    }
    // Answers that came in while this turn could not take them go out now. A
    // stopped or failed turn keeps them for the next prompt the user sends.
    if (result.status === 'done' && !next.archived && this.threads.deferred.deferredAnswers.has(threadId)) {
      setTimeout(() => this.threads.deferred.flushDeferred(threadId), 0);
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
    this.core.log('info', `thread ${thread.id}: the agent has no session ${thread.sessionId} any more (${result.error ?? 'no reason given'}); starting a fresh one with the thread's history`);
    saveThread(this.core, { ...current, sessionId: null, sessionGeneration: generation, context: null, promptCache: null }, 'thread.updated');
    return { ...thread, sessionId: null, sessionGeneration: generation, context: null, promptCache: null };
  }

  stopRunning(threadId: ThreadId): boolean {
    const handle = this.handles.get(threadId);
    if (handle === undefined) return false;
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
