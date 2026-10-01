import type { Message, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';
import { MemoryNotices } from './memory-notices.ts';
import { newId } from '../ids.ts';
import { withLoad } from './records.ts';

/**
 * What reaches an agent outside a prompt the user typed: answers to
 * asynchronous questions, steered in or held for the next turn, and the
 * turns an agent opens by itself when background work finishes.
 */
export class DeferredInput {
  readonly memory: MemoryNotices;
  /**
   * Answers to asynchronous questions that could not reach the agent yet: a
   * turn was running with no way to steer it, or queued. They go out together
   * as the next prompt once that turn finished.
   */
  readonly deferredAnswers = new Map<ThreadId, string[]>();
  /** A driver asked for a background turn while the thread's last turn was still closing. */
  readonly pendingWakes = new Map<ThreadId, string>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    this.memory = new MemoryNotices(core, threads);
  }

  /**
   * An asynchronous answer on its way to the agent: steered into the running
   * turn when the driver can, held while a turn is busy and cannot take it, or
   * sent as a prompt of its own when the thread is idle.
   */
  deliverAnswer(threadId: ThreadId, text: string): void {
    if (this.enqueueResident(threadId, text)) return;
    this.defer(threadId, text);
    const handle = this.threads.runner.handles.get(threadId);
    if (handle?.steer && !this.threads.runner.steering.has(threadId)) {
      const turnId = this.core.journal.listTurns(threadId).findLast(turn => turn.status === 'running')?.id;
      this.threads.runner.steering.add(threadId);
      void handle.steer(text)
        .then(submitted => {
          if (this.core.stopping) return;
          if (!submitted) return;
          if (turnId) this.threads.runner.userInputAt.set(turnId, this.recordAnswer(threadId, turnId, text));
          const held = this.deferredAnswers.get(threadId) ?? [];
          const index = held.indexOf(text);
          if (index >= 0) held.splice(index, 1);
          if (!held.length) this.deferredAnswers.delete(threadId);
          this.changed(threadId);
        })
        .catch(error => {
          if (this.core.stopping) return;
          this.core.log('warn', `thread ${threadId}: steering an async answer failed, it waits for the next turn: ${messageOf(error)}`);
        })
        .finally(() => {
          this.threads.runner.steering.delete(threadId);
          if (this.core.stopping) return;
          // A late rejection must not undo Stop or retry a failed turn.
          if (!this.threads.runner.handles.has(threadId) && turnId && this.core.journal.getTurn(turnId)?.status === 'done') this.flushDeferred(threadId);
          void this.memory.flushRunning(threadId);
        });
      return;
    }
    if (!this.threads.runner.handles.has(threadId)) this.flushDeferred(threadId);
  }

  private defer(threadId: ThreadId, text: string): void {
    this.deferredAnswers.set(threadId, [...(this.deferredAnswers.get(threadId) ?? []), text]);
    this.changed(threadId);
  }

  private changed(threadId: ThreadId): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread) this.core.bus.emit('thread.updated', withLoad(this.core, thread));
  }

  private recordAnswer(threadId: ThreadId, turnId: string, text: string, createdAt = Date.now()): number {
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'user', state: 'complete', createdAt, parts: [{ type: 'text', text }] };
    this.core.journal.append({ type: 'message.started', threadId, version: 1, payload: message }, () => this.core.journal.putMessage(message));
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
    return createdAt;
  }

  /** Journal held answers before the manual prompt that will carry them. */
  recordHeldBeforePrompt(threadId: ThreadId, turnId: string, promptAt: number): void {
    if (this.threads.runner.steering.has(threadId)) return;
    const held = this.deferredAnswers.get(threadId);
    if (held?.length) this.recordAnswer(threadId, turnId, held.join('\n\n'), promptAt - 1);
  }

  /** The held answers as one prompt, when the thread can take one. */
  flushDeferred(threadId: ThreadId): void {
    if (this.core.stopping) return;
    const held = this.deferredAnswers.get(threadId);
    const thread = this.core.journal.getThread(threadId);
    if (held === undefined || thread === null || thread.archived) return;
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.threads.runner.handles.has(threadId) || this.threads.runner.steering.has(threadId)) return;
    this.deferredAnswers.delete(threadId);
    try {
      this.threads.startTurn(threadId, held.join('\n\n'));
    } catch (error) {
      // Kept for the next prompt the user sends, which carries them first.
      this.deferredAnswers.set(threadId, held);
      this.core.log('warn', `thread ${threadId}: async answers wait for the next prompt: ${messageOf(error)}`);
    }
    this.changed(threadId);
  }

  /**
   * The held answers for the running turn to read at a tool boundary. A driver
   * with no steer (Claude) pulls them from its PostToolUse hook, so an answer
   * given mid-turn does not wait for the turn to end.
   */
  takeForRunningTurn(threadId: ThreadId): string | null {
    const memory = this.memory.take(threadId);
    if (memory) return memory;
    // A native steer already owns delivery until its acknowledgement arrives.
    if (this.threads.runner.steering.has(threadId)) return null;
    const held = this.deferredAnswers.get(threadId);
    if (held === undefined) return null;
    const turnId = this.core.journal.listTurns(threadId).findLast(turn => turn.status === 'running')?.id;
    if (turnId) this.threads.runner.userInputAt.set(turnId, this.recordAnswer(threadId, turnId, held.join('\n\n')));
    this.deferredAnswers.delete(threadId);
    this.changed(threadId);
    return `The user answered while you were working:\n\n${held.join('\n\n')}`;
  }

  /** What was held and never sent: it goes in front of the next prompt. */
  takeDeferred(threadId: ThreadId): string {
    if (this.threads.runner.steering.has(threadId)) return '';
    const held = this.deferredAnswers.get(threadId);
    if (held === undefined) return '';
    this.deferredAnswers.delete(threadId);
    this.changed(threadId);
    return held.join('\n\n') + '\n\n';
  }

  /**
   * The agent went on by itself once the turn ended: a background shell it
   * started finished. A turn opens for what it writes next; when the thread is
   * busy the running turn takes that output instead.
   */
  wake(threadId: ThreadId, text: string): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived) return;
    if (this.enqueueResident(threadId, text)) return;
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.threads.runner.handles.has(threadId)) {
      // The turn that ended is still being saved: open this one right after it.
      this.pendingWakes.set(threadId, text);
      return;
    }
    try {
      this.threads.startTurn(threadId, text, [], undefined, 'background');
    } catch (error) {
      this.core.log('warn', `thread ${threadId}: the agent resumed on its own but no turn could open: ${messageOf(error)}`);
    }
  }

  private enqueueResident(threadId: ThreadId, text: string): boolean {
    const thread = this.core.journal.getThread(threadId);
    if (!thread?.agentSessionId || thread.archived) return false;
    // A resident thread never falls back to a direct turn: a refused session only logs.
    try {
      const session = this.core.workforce.session(threadId);
      this.core.workforce.resident.enqueue(session.agentId, text, session.scope);
      this.core.workforce.changed();
    } catch (error) {
      this.core.log('warn', `thread ${threadId}: resident work was not queued: ${messageOf(error)}`);
    }
    return true;
  }
}
