import type { PermissionMode, ThreadId, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { getDriver, releaseThread } from '../drivers/index.ts';
import type { TurnResult } from '../drivers/types.ts';
import { messageOf } from '../errors.ts';
import { logMessageOf } from '../log-errors.ts';
import { promptCacheOf } from '../prompt-cache.ts';
import type { ThreadStore } from '../threads.ts';
import { saveThread, setThreadStatus } from './records.ts';
import { TurnAttempts, type TurnAttemptState } from './turn-attempts.ts';

export { STOP_DEADLINE, STOP_DEADLINE_ERROR } from './turn-attempts.ts';

/**
 * One turn from the scheduler to its end: the driver started and awaited,
 * a lost session retried once on a fresh one, a stop that the agent
 * ignores ended by the deadline, and what the finished turn leaves behind.
 */
export class TurnRunner {
  private readonly attempts: TurnAttempts;
  readonly handles: TurnAttempts['handles'];
  readonly steering = new Set<ThreadId>();
  /**
   * Standalone messages inserted during a running answer, with their timestamps.
   * The turn's emitter starts its next segment after the latest one.
   */
  readonly answerAfter = new Map<TurnId, number>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    this.attempts = new TurnAttempts(core, threads);
    this.handles = this.attempts.handles;
  }

  changePermissionMode(threadId: ThreadId, mode: PermissionMode): void {
    this.attempts.changePermissionMode(threadId, mode);
  }

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
    const state: TurnAttemptState = {
      threadId, turnId,
      thread: { ...selected, ...queued.execution, permissionMode: selected.permissionMode },
      running: { ...queued, status: 'running', startedAt: Date.now() },
    };
    const permissions = this.attempts.open(state);

    let result: TurnResult;
    try {
      // Commit the running state before a driver can spawn or stream output.
      this.threads.progress.begin(threadId, turnId);
      this.core.bus.afterCommit(() => this.core.journal.db.transaction(() => {
        this.core.journal.append({ type: 'turn.started', threadId, version: 1, payload: state.running }, () => {
          this.core.journal.putTurn(state.running);
        });
        this.core.bus.emit('turn.started', state.running);
        setThreadStatus(this.core, threadId, 'running');
      })());
      this.core.workforce.resident.assertThreadRoute(threadId, state.thread);
      const provider = this.core.providers.require(state.thread.providerId);
      const account = this.core.accounts.require(state.thread.accountId);
      const driver = getDriver(provider.protocol);
      result = await this.attempts.run(queued, state, { provider, account, driver }, permissions);
      if (state.running.execution?.operation === 'coordination' && result.status === 'done') this.core.coordination.submitted(threadId, turnId);
    } catch (error) {
      result = { status: 'error', sessionId: state.thread.sessionId, usage: null, error: messageOf(error), diagnosticError: logMessageOf(error) };
    } finally {
      this.attempts.close(threadId);
      this.answerAfter.delete(turnId);
    }

    const { thread, running } = state;
    const checkpoint = this.threads.codeCheckpoints.end(turnId);
    if (checkpoint) await checkpoint;
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
      ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
    };
    const completion = this.core.bus.afterCommit(() => this.core.journal.db.transaction(() => {
      this.threads.progress.end(threadId, turnId);
      this.core.journal.append({ type: 'turn.finished', threadId, version: 1, payload: finished }, () => {
        this.core.journal.putTurn(finished);
      });
      this.core.bus.emit('turn.finished', finished);
      if (result.status === 'error') {
        this.core.log('error', `turn ${turnId} failed: ${result.diagnosticError ?? result.error ?? 'unknown error'}`, { source: thread.providerId, event: 'turn.failed', threadId, turnId });
      }
      const current = this.core.journal.getThread(threadId);
      if (current === null) return null;
      const sameSession = (current.sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0);
      if (current.archived || !sameSession) releaseThread(threadId);
      // A lost session already moved the generation on, so do not bump it again.
      const sessionId = sameSession ? result.sessionId ?? current.sessionId : current.sessionId;
      const next: ThreadSummary = {
        ...current,
        sessionId,
        // Keep a cut only while the thread still names the session it cuts.
        sessionResumeAt: current.sessionResumeAt && sessionId === current.sessionId && sessionId === thread.sessionId ? current.sessionResumeAt : null,
        status: result.status === 'error' ? 'error' : 'idle',
        unread: current.unread || !this.core.subscribers.hasSubscribers(threadId),
        promptCache: sameSession ? promptCacheOf(result, thread, finished.finishedAt ?? Date.now(), current.promptCache ?? null) ?? current.promptCache ?? null : current.promptCache ?? null,
      };
      saveThread(this.core, next, 'thread.finished');
      return { next, sameSession };
    })());
    if (completion === null) return;
    const { next, sameSession } = completion;
    // A move the agent asked for during the turn happens now that no process
    // works in the old folder, before any wake or held answer starts the next.
    await this.threads.moves.applyWaiting(threadId);
    // A thread an agent started answers it before a failure pauses its coordination.
    await this.threads.spawns.finished(finished);
    if (result.status !== 'done') this.core.coordination.pause(threadId);
    if (result.status === 'done' && sameSession && !queued.execution?.operation) this.threads.titles.autoRefine(threadId);
    if (sameSession) this.threads.autoCompact.turnFinished(next, finished);
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

  stopRunning(threadId: ThreadId): boolean {
    return this.attempts.stopRunning(threadId);
  }
}
