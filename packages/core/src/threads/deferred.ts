import type { Message, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { TurnHandle } from '../drivers/types.ts';
import { messageOf } from '../errors.ts';
import { isAgentHeld } from '../agents/runtime.ts';
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
  /**
   * Held text already written into the journal, waiting for the prompt that
   * carries it. It leaves `deferredAnswers` so a stopped start cannot journal
   * the same answer again, and so the pending bubble does not sit beside it.
   */
  readonly consumed = new Map<ThreadId, string>();
  /** A driver asked for a background turn while the thread's last turn was still closing. */
  readonly pendingWakes = new Map<ThreadId, string>();
  /** What background work wrote while a persistent agent was held (paused, out of budget): one turn once it may run. */
  private readonly heldWakes = new Map<ThreadId, string[]>();
  private readonly flushing = new Map<ThreadId, boolean>();
  private readonly uncertain = new WeakSet<TurnHandle>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    this.memory = new MemoryNotices(core, threads);
  }

  /**
   * An asynchronous answer on its way to the agent: steered into the running
   * turn when the driver can, held while a turn is busy and cannot take it, or
   * sent as a prompt of its own when the thread is idle.
   */
  deliverAnswer(threadId: ThreadId, text: string): void {
    this.defer(threadId, text);
    void this.flushRunning(threadId);
    if (!this.threads.runner.handles.has(threadId)) this.flushDeferred(threadId);
  }

  /** Drain answers and memory notices after any owner releases native steering. */
  async flushRunning(threadId: ThreadId): Promise<void> {
    if (this.core.stopping) return;
    if (this.flushing.has(threadId)) {
      this.flushing.set(threadId, true);
      return;
    }
    if (this.threads.runner.steering.has(threadId)) return;
    this.flushing.set(threadId, true);
    try {
      while (this.flushing.get(threadId) && !this.core.stopping) {
        this.flushing.set(threadId, false);
        if (this.deferredAnswers.get(threadId)?.length) await this.steerAnswers(threadId);
        await this.memory.flushRunning(threadId);
      }
    } finally {
      this.flushing.delete(threadId);
    }
  }

  private async steerAnswers(threadId: ThreadId): Promise<void> {
    const runner = this.threads.runner;
    const handle = runner.handles.get(threadId);
    if (!handle?.steer || this.uncertain.has(handle) || runner.steering.has(threadId) || !this.deferredAnswers.get(threadId)?.length) return;
    const turnId = this.core.journal.runningTurn(threadId)?.id;
    runner.steering.add(threadId);
    let recorded = false;
    try {
      while (!this.core.stopping && runner.handles.get(threadId) === handle) {
        const text = this.deferredAnswers.get(threadId)?.[0];
        if (text === undefined) break;
        recorded = false;
        const accepted = () => {
          if (recorded || this.core.stopping) return;
          if (turnId) runner.answerAfter.set(turnId, this.recordAnswer(threadId, turnId, text));
          const held = this.deferredAnswers.get(threadId) ?? [];
          const index = held.indexOf(text);
          if (index >= 0) held.splice(index, 1);
          if (!held.length) this.deferredAnswers.delete(threadId);
          recorded = true;
          this.changed(threadId);
        };
        if (await handle.steer(text, undefined, accepted)) accepted();
        if (!recorded) break;
      }
    } catch (error) {
      // A transport may have sent the text before it lost the acknowledgement.
      if (!recorded) this.uncertain.add(handle);
      if (!this.core.stopping) this.core.log('warn', `thread ${threadId}: steering an async answer failed, it waits for the next turn: ${messageOf(error)}`);
    } finally {
      runner.steering.delete(threadId);
      // A late rejection must not undo Stop or retry a failed turn.
      if (!this.core.stopping && !runner.handles.has(threadId) && turnId && this.core.journal.getTurn(turnId)?.status === 'done') this.flushDeferred(threadId);
    }
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
    if (!held?.length) return;
    const text = held.join('\n\n');
    this.recordAnswer(threadId, turnId, text, promptAt - 1);
    // No `changed` here: this runs inside the startTurn transaction, and the
    // status event after it already sees the empty map.
    this.deferredAnswers.delete(threadId);
    const previous = this.consumed.get(threadId);
    this.consumed.set(threadId, previous ? `${previous}\n\n${text}` : text);
  }

  /** The held answers as one prompt, when the thread can take one. */
  flushDeferred(threadId: ThreadId): void {
    if (this.core.stopping) return;
    const held = this.deferredAnswers.get(threadId);
    const thread = this.core.journal.getThread(threadId);
    if (held === undefined || thread === null || thread.archived) return;
    if (this.threads.isBusy(threadId) || this.threads.runner.steering.has(threadId)) return;
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
    const turnId = this.core.journal.runningTurn(threadId)?.id;
    if (turnId) this.threads.runner.answerAfter.set(turnId, this.recordAnswer(threadId, turnId, held.join('\n\n')));
    this.deferredAnswers.delete(threadId);
    this.changed(threadId);
    return `The user answered while you were working:\n\n${held.join('\n\n')}`;
  }

  /** What was held and never sent: it goes in front of the next prompt. */
  takeDeferred(threadId: ThreadId): string {
    if (this.threads.runner.steering.has(threadId)) return '';
    const consumed = this.consumed.get(threadId);
    const held = this.deferredAnswers.get(threadId);
    this.consumed.delete(threadId);
    if (held !== undefined) {
      this.deferredAnswers.delete(threadId);
      this.changed(threadId);
    }
    const text = [consumed, held?.length ? held.join('\n\n') : undefined].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n');
    return text.length > 0 ? `${text}\n\n` : '';
  }

  /**
   * The agent went on by itself once the turn ended: a background shell it
   * started finished. A turn opens for what it writes next; when the thread is
   * busy the running turn takes that output instead.
   */
  wake(threadId: ThreadId, text: string): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived) return;
    if (this.threads.isBusy(threadId)) {
      // The turn that ended is still being saved: open this one right after it.
      this.pendingWakes.set(threadId, text);
      return;
    }
    try {
      this.threads.startTurn(threadId, text, { kind: 'background' });
    } catch (error) {
      if (isAgentHeld(error)) {
        this.heldWakes.set(threadId, [...this.heldWakes.get(threadId) ?? [], text]);
        this.core.agentRuntime.whenAdmitted(threadId, 'background', () => {
          const held = this.heldWakes.get(threadId) ?? [];
          this.heldWakes.delete(threadId);
          if (held.length) this.wake(threadId, held.join('\n\n'));
        });
        return;
      }
      this.core.log('warn', `thread ${threadId}: the agent resumed on its own but no turn could open: ${messageOf(error)}`);
    }
  }
}
