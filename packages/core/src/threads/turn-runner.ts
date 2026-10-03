import type { PermissionMode, ThreadId, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { getDriver, releaseThread } from '../drivers/index.ts';
import type { TurnResult } from '../drivers/types.ts';
import { messageOf } from '../errors.ts';
import { logMessageOf } from '../log-errors.ts';
import { reportSettlementError, settleTurn } from './turn-settlement.ts';
import type { ThreadStore } from '../threads.ts';
import { setThreadStatus, withLoad } from './records.ts';
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

  /** Mail is a timeline boundary even when the provider has not accepted it yet. */
  noteMail(threadId: ThreadId, at: number): void {
    const turn = this.core.journal.listTurns(threadId).findLast(turn => turn.status === 'running');
    if (turn) this.answerAfter.set(turn.id, Math.max(at, this.answerAfter.get(turn.id) ?? 0));
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
    let started = false;
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
      started = true;
      this.core.workforce.resident.assertThreadRoute(threadId, state.thread);
      const provider = this.core.providers.require(state.thread.providerId);
      const account = this.core.accounts.require(state.thread.accountId);
      const driver = getDriver(provider.protocol);
      result = await this.attempts.run(queued, state, { provider, account, driver }, permissions);
      if (state.running.execution?.operation === 'coordination' && result.status === 'done') this.core.coordination.submitted(threadId, turnId);
    } catch (error) {
      result = { status: 'error', sessionId: state.thread.sessionId, usage: null, error: messageOf(error), diagnosticError: logMessageOf(error) };
    } finally {
      try { this.attempts.close(threadId); }
      catch (error) { reportSettlementError(this.core, threadId, turnId, 'attempt cleanup', error); }
      this.answerAfter.delete(turnId);
    }

    const { thread, running } = state;
    try {
      const checkpoint = this.threads.codeCheckpoints.end(turnId);
      if (checkpoint) await checkpoint;
    } catch (error) { reportSettlementError(this.core, threadId, turnId, 'checkpoint', error); }
    if (this.core.journal.isClosed()) return;
    try { this.core.delegation.submitted(threadId, turnId, result.status === 'done'); }
    catch (error) { reportSettlementError(this.core, threadId, turnId, 'delegation submission', error); }
    const finished: Turn = {
      ...running,
      status: result.status === 'done' ? 'done' : result.status,
      finishedAt: Date.now(),
      usage: result.usage,
      error: result.error ?? null,
      ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
    };
    const completion = await settleTurn(this.core, { queued, running, thread, result, started, finished });
    // No in-memory events or after-finish effects run before the transaction
    // commits. Even a failure in the thread write cannot publish completion twice.
    if (completion === null) {
      // An abandoned result still owns its old progress, but a newer turn does not.
      if (!this.core.journal.isClosed()) this.threads.progress.end(threadId, turnId);
      return;
    }
    const { next, sameSession, threadOwned } = completion;
    this.threads.progress.end(threadId, turnId);
    if (threadOwned) {
      try {
        this.threads.cards.clearPermissionsOf(threadId);
        this.threads.cards.clearQuestionsOf(threadId);
      } catch (error) { reportSettlementError(this.core, threadId, turnId, 'card cleanup', error); }
    }
    this.core.bus.emit('turn.finished', finished);
    if (result.status === 'error') {
      this.core.log('error', `turn ${turnId} failed: ${result.diagnosticError ?? result.error ?? 'unknown error'}`, { source: thread.providerId, event: 'turn.failed', threadId, turnId });
    }
    if (!next) return;
    if (!threadOwned) {
      // This completion still belongs to its parent, even if the child thread
      // now names a newer execution. Do not run work against that execution.
      await this.threads.spawns.finished(finished);
      return;
    }
    if (next.archived) releaseThread(threadId);
    this.core.bus.emit('thread.updated', withLoad(this.core, next));
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
