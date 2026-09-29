import type { Message, MessageId, MessagePart, ThreadId, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { newId } from '../ids.ts';
import { saveThread } from './records.ts';

/** What a turn a dead core left behind says, once the next core has closed it. */
export const CRASH_WHILE_RUNNING = 'The core stopped while this turn was running; send the prompt again.';
export const CRASH_WHILE_QUEUED = 'The core stopped while this turn was queued; send the prompt again.';

/**
 * Closes what a core that died mid-turn left open, before the next one
 * accepts a connection.
 */
export class ThreadRecovery {
  constructor(private readonly core: Core) {}

  /**
   * A core that dies mid-turn leaves that turn `running` or `queued` in the
   * journal, and the next start comes up with an empty scheduler: nothing would
   * ever finish it, so the thread would read as busy forever. Every such turn
   * becomes an error here, through the same events a failing turn writes, before
   * the server accepts a connection. Nothing is retried: the prompt is in the
   * journal and the user sends it again.
   */
  recoverStuckTurns(): number {
    const stuck = this.core.journal.unfinishedTurns();
    for (const turn of stuck) {
      const previous = turn.status;
      this.core.journal.db.transaction(() => {
        this.failStuckTurn(turn, previous === 'running' ? CRASH_WHILE_RUNNING : CRASH_WHILE_QUEUED);
        if (previous === 'queued' && turn.execution?.operation === 'coordination') this.core.coordination.queuedCancelled(turn.threadId);
      })();
      this.core.log(
        'warn',
        `recovered turn ${turn.id} of thread ${turn.threadId}, left ${previous} by a stopped core`,
      );
    }
    for (const thread of this.core.journal.listThreads()) {
      if (['queued', 'running', 'waiting'].includes(thread.status)) {
        saveThread(this.core, { ...thread, status: 'idle' }, 'thread.finished');
      }
    }
    return stuck.length;
  }

  private failStuckTurn(turn: Turn, reason: string): void {
    const threadId = turn.threadId;
    const thread = this.core.journal.getThread(threadId);
    if (thread !== null) {
      // The turn's own messages, and only the ones still open: a caret left
      // blinking on a message nobody will ever write to again is the visible half
      // of this bug.
      // Through the turn index: the rest of the thread, images included, is never parsed.
      const streaming = Array.from(this.core.journal.walkTurnMessages(threadId, turn.id))
        .filter((message) => message.state === 'streaming');
      const carrier = streaming.at(-1) ?? this.openRecoveryMessage(turn);
      const index = carrier.parts.length;
      const part: MessagePart = { type: 'error', message: reason };
      this.core.journal.append(
        { type: 'message.part', threadId, version: 1, payload: { messageId: carrier.id, partIndex: index, part } },
        () => {
          this.core.journal.setMessagePart(carrier.id, index, part);
        },
      );
      this.core.bus.emit('message.part', { threadId, messageId: carrier.id, partIndex: index, part });
      for (const message of streaming) if (message.id !== carrier.id) this.closeAsError(threadId, message.id);
      this.closeAsError(threadId, carrier.id);
    }

    const finished: Turn = { ...turn, status: 'error', finishedAt: Date.now(), error: reason };
    this.core.journal.append({ type: 'turn.finished', threadId, version: 1, payload: finished }, () => {
      this.core.journal.putTurn(finished);
    });
    this.core.bus.emit('turn.finished', finished);

    if (thread === null) return;
    saveThread(this.core, { ...thread, status: 'idle' }, 'thread.finished');
  }

  /** A queued turn never opened a message; the error needs one to live in. */
  private openRecoveryMessage(turn: Turn): Message {
    const message: Message = {
      id: newId('msg_'),
      threadId: turn.threadId,
      turnId: turn.id,
      role: 'assistant',
      parts: [],
      state: 'streaming',
      createdAt: Date.now(),
    };
    this.core.journal.append(
      { type: 'message.started', threadId: turn.threadId, version: 1, payload: message },
      () => {
        this.core.journal.putMessage(message);
      },
    );
    this.core.bus.emit('message.started', message);
    return message;
  }

  private closeAsError(threadId: ThreadId, messageId: MessageId): void {
    this.core.journal.append(
      { type: 'message.completed', threadId, version: 1, payload: { messageId, state: 'error' } },
      () => {
        this.core.journal.setMessageState(messageId, 'error');
      },
    );
    this.core.bus.emit('message.completed', { threadId, messageId, state: 'error' });
  }
}
