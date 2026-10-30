import { ACTIVE_THREAD_STATUSES } from '@boite/contracts';
import type { Message, MessageId, MessagePart, RpcParams, ThreadId, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { assertDriverRunnable } from '../drivers/index.ts';
import { notFound, refused } from '../errors.ts';
import { requireAgent } from './agentless.ts';
import { newId } from '../ids.ts';
import { markQueued, settleStatus } from './lifecycle.ts';
import { checkStoredEffort, checkStoredSpeed } from './selection.ts';
import { announceFinished, finishTurn } from './turn-settlement.ts';

/** What a turn a dead core left behind says, once the next core has closed it. */
export const CRASH_WHILE_RUNNING = 'The core stopped while this turn was running; send the prompt again.';
/** The same, for a turn that resumes by itself once the core started (`threads/auto-continue.ts`). */
export const CRASH_RESUMING = 'The core stopped while this turn was running; Boite resumes it.';
export const CRASH_WHILE_QUEUED = 'The core stopped while this turn was queued; send the prompt again.';

/**
 * Closes what a core that died mid-turn left open, before the next one
 * accepts a connection.
 */
export class ThreadRecovery {
  readonly #core: Core;

  constructor(core: Core) {
    this.#core = core;}

  /**
   * A core that dies mid-turn leaves that turn `running` or `queued` in the
   * journal, and the next start comes up with an empty scheduler: nothing would
   * ever finish it. Unsent ordinary prompts retain their identity and frozen
   * selection, held until the user resumes or discards them. A turn that may
   * have reached its provider becomes an error; it is never replayed here, but
   * a conversation's turn cut within the hour gets a continuation once the
   * core started (`threads/auto-continue.ts`).
   */
  recoverStuckTurns(): number {
    const stuck = this.#core.journal.unfinishedTurns();
    const handoff = this.#core.threads.handoff;
    const inherited = handoff.inheritedTurns();
    /** Threads whose queued turn goes back in line once the server listens. */
    const waiting = new Set<ThreadId>();
    const counts = { requeued: 0, held: 0, handedOver: 0, failed: 0 };
    for (const turn of stuck) {
      const previous = turn.status;
      if (handoff.requeues(turn)) {
        counts.requeued += 1;
        this.#core.logs.info(`Turn ${turn.id} was handed over by the previous core and goes back in the queue`, { source: 'turns', event: 'turn.recovery.requeued', threadId: turn.threadId, turnId: turn.id, data: { previous } });
        waiting.add(turn.threadId);
        continue;
      }
      const thread = this.#core.journal.getThread(turn.threadId);
      if (previous === 'queued' && turn.startedAt === null && turn.execution
        && !turn.execution.operation && thread && !thread.archived && !thread.parentThreadId) {
        const held: Turn = { ...turn, queueHold: turn.queueHold ?? { reason: 'core-restarted', since: Date.now() } };
        this.#core.bus.afterCommit(() => this.#core.journal.db.transaction(() => {
          if (!turn.queueHold) this.#core.journal.append({ type: 'turn.held', threadId: turn.threadId, version: 1, payload: held }, () => this.#core.journal.putTurn(held));
          markQueued(this.#core, turn.threadId);
        })());
        this.#core.scheduler.enqueue(held, held.execution!.accountId);
        counts.held += 1;
        this.#core.logs.info(`Turn ${turn.id} was queued when the previous core stopped; it is held until the user resumes or discards it`, { source: 'turns', event: 'turn.recovery.held', threadId: turn.threadId, turnId: turn.id, data: { reason: held.queueHold!.reason } });
        waiting.add(turn.threadId);
        continue;
      }
      if (previous === 'running' && inherited.get(turn.id) === 'running') {
        // Killed during a restart handoff: the next turn of the thread resumes it, so this is no failure.
        this.#core.journal.db.transaction(() => this.#closeHandedOver(turn))();
        counts.handedOver += 1;
        this.#core.logs.info(`Turn ${turn.id} was stopped by a restart handoff; the thread's next turn resumes it`, { source: 'turns', event: 'turn.recovery.handed-over', threadId: turn.threadId, turnId: turn.id });
        continue;
      }
      const resumes = previous === 'running' && this.#core.threads.autoContinue.resumesCrashed(turn);
      this.#core.journal.db.transaction(() => {
        this.#failStuckTurn(turn, previous === 'running' ? resumes ? CRASH_RESUMING : CRASH_WHILE_RUNNING : CRASH_WHILE_QUEUED);
        if (previous === 'queued' && turn.execution?.operation === 'coordination') this.#core.coordination.queuedCancelled(turn.threadId, turn.id);
      })();
      counts.failed += 1;
      this.#core.log(
        'warn',
        `recovered turn ${turn.id} of thread ${turn.threadId}, left ${previous} by a stopped core`,
        { source: 'turns', event: 'turn.recovery.failed', threadId: turn.threadId, turnId: turn.id, data: { previous } },
      );
    }
    if (stuck.length > 0) {
      // Requeued, held or handed over turns are a normal restart: only a failed one is worth a warning.
      this.#core.logs.record(counts.failed > 0 ? 'warn' : 'info', `Recovered ${stuck.length} unfinished turns left by the previous core: ${counts.requeued} requeued, ${counts.held} held, ${counts.handedOver} handed over, ${counts.failed} marked failed`, {
        source: 'startup', event: 'startup.turns-recovered', data: { total: stuck.length, ...counts },
      });
    }
    for (const thread of this.#core.journal.listThreadsWithStatus(ACTIVE_THREAD_STATUSES)) {
      if (!waiting.has(thread.id)) settleStatus(this.#core, thread.id);
    }
    return stuck.length;
  }

  /** Changing a held prompt never makes a second turn or input receipt. */
  recover(params: RpcParams<'turns.recover'>): Turn {
    const { threadId, turnId, action } = params;
    if (action !== 'resume' && action !== 'discard') throw refused('action must be resume or discard', { field: 'action', expected: ['resume', 'discard'] });
    if (this.#core.stopping) throw refused('the core is stopping; reconnect before recovering a prompt');
    const thread = requireAgent(this.#core.threads, threadId);
    const turn = this.#core.journal.getTurn(turnId);
    if (!turn || turn.threadId !== threadId) throw notFound('turnId must name a turn of this thread', { field: 'turnId', threadId, turnId });
    // A response lost after admission is an idempotent read, not another launch.
    if (turn.status !== 'queued' || !turn.queueHold) return turn;
    if (action === 'discard') {
      if (!this.#core.scheduler.stop(threadId)) this.#core.threads.markQueuedStopped(turnId);
      return this.#core.journal.getTurn(turnId)!;
    }
    if (thread.archived) throw refused('cannot resume a prompt on an archived thread', { threadId });
    const target = turn.execution;
    if (!target || target.operation || thread.parentThreadId) throw refused('only an unsent conversation prompt can be resumed', { turnId });
    this.#core.threads.codeCheckpoints.assertAvailable(thread.cwd);
    const provider = this.#core.providers.require(target.providerId);
    const account = this.#core.accounts.require(target.accountId);
    if (account.providerId !== provider.id) throw refused('the saved account belongs to another provider', { accountId: account.id, providerId: provider.id });
    // A provider updating holds the resumed prompt in the queue until its updater is done.
    assertDriverRunnable(provider.protocol, this.#core.providers.summary(provider.id), account, () => this.#core.providers.launcherScriptOnly(provider.id));
    checkStoredEffort(provider, account.id, target.model, target.effort);
    checkStoredSpeed(provider, account.id, target.model, target.speed ?? null);
    const resumed: Turn = { ...turn, queueHold: null };
    this.#core.journal.append({ type: 'turn.resumed', threadId, version: 1, payload: resumed }, () => this.#core.journal.putTurn(resumed));
    this.#core.scheduler.enqueue(resumed, account.id);
    return resumed;
  }

  /** A turn the previous core was handing over when it was killed: stopped, with no error part. */
  #closeHandedOver(turn: Turn): void {
    const threadId = turn.threadId;
    for (const message of this.#core.journal.walkTurnMessages(threadId, turn.id, { blobs: false })) {
      if (message.state !== 'streaming') continue;
      this.#core.journal.append(
        { type: 'message.completed', threadId, version: 1, payload: { messageId: message.id, state: 'complete' } },
        () => {
          this.#core.journal.setMessageState(message.id, 'complete');
        },
      );
      this.#core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
    }
    const stopped: Turn = { ...turn, status: 'stopped', finishedAt: Date.now() };
    announceFinished(this.#core, stopped, finishTurn(this.#core, stopped, 'handed-over'));
  }

  #failStuckTurn(turn: Turn, reason: string): void {
    const threadId = turn.threadId;
    if (this.#core.journal.getThread(threadId) !== null) {
      // The turn's own messages, and only the ones still open: a caret left
      // blinking on a message nobody will ever write to again is the visible half
      // of this bug.
      // Through the turn index: the rest of the thread, images included, is never parsed.
      const streaming = Array.from(this.#core.journal.walkTurnMessages(threadId, turn.id, { blobs: false }))
        .filter((message) => message.state === 'streaming');
      const carrier = streaming.at(-1) ?? this.#openRecoveryMessage(turn);
      const index = carrier.parts.length;
      const part: MessagePart = { type: 'error', message: reason };
      this.#core.journal.append(
        { type: 'message.part', threadId, version: 1, payload: { messageId: carrier.id, partIndex: index, part } },
        () => {
          this.#core.journal.setMessagePart(carrier.id, index, part);
        },
      );
      this.#core.bus.emit('message.part', { threadId, messageId: carrier.id, partIndex: index, part });
      for (const message of streaming) if (message.id !== carrier.id) this.#closeAsError(threadId, message.id);
      this.#closeAsError(threadId, carrier.id);
    }

    // The thread rests where a live failure leaves it: `error` (`threads/lifecycle.ts`).
    const finished: Turn = { ...turn, status: 'error', finishedAt: Date.now(), error: reason };
    announceFinished(this.#core, finished, finishTurn(this.#core, finished, 'crashed'));
  }

  /** A queued turn never opened a message; the error needs one to live in. */
  #openRecoveryMessage(turn: Turn): Message {
    const message: Message = {
      id: newId('msg_'),
      threadId: turn.threadId,
      turnId: turn.id,
      role: 'assistant',
      parts: [],
      state: 'streaming',
      createdAt: Date.now(),
    };
    this.#core.journal.append(
      { type: 'message.started', threadId: turn.threadId, version: 1, payload: message },
      () => {
        this.#core.journal.putMessage(message);
      },
    );
    this.#core.bus.emit('message.started', message);
    return message;
  }

  #closeAsError(threadId: ThreadId, messageId: MessageId): void {
    this.#core.journal.append(
      { type: 'message.completed', threadId, version: 1, payload: { messageId, state: 'error' } },
      () => {
        this.#core.journal.setMessageState(messageId, 'error');
      },
    );
    this.#core.bus.emit('message.completed', { threadId, messageId, state: 'error' });
  }
}
