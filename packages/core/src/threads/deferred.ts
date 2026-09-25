import type { ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';

/**
 * What reaches an agent outside a prompt the user typed: answers to
 * asynchronous questions, steered in or held for the next turn, and the
 * turns an agent opens by itself when background work finishes.
 */
export class DeferredInput {
  /**
   * Answers to asynchronous questions that could not reach the agent yet: a
   * turn was running with no way to steer it, or queued. They go out together
   * as the next prompt once that turn finished.
   */
  readonly deferredAnswers = new Map<ThreadId, string[]>();
  /** A driver asked for a background turn while the thread's last turn was still closing. */
  readonly pendingWakes = new Map<ThreadId, string>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  /**
   * An asynchronous answer on its way to the agent: steered into the running
   * turn when the driver can, held while a turn is busy and cannot take it, or
   * sent as a prompt of its own when the thread is idle.
   */
  deliverAnswer(threadId: ThreadId, text: string): void {
    if (this.enqueueResident(threadId, text)) return;
    const handle = this.threads.runner.handles.get(threadId);
    if (handle?.steer && !this.threads.runner.steering.has(threadId)) {
      this.threads.runner.steering.add(threadId);
      const hold = () => {
        this.defer(threadId, text);
        // The turn may have ended while the steer was out, after its end looked for held answers.
        if (!this.threads.runner.handles.has(threadId)) this.flushDeferred(threadId);
      };
      void handle.steer(text)
        .then(submitted => { if (!submitted) hold(); })
        .catch(error => {
          this.core.log('warn', `thread ${threadId}: steering an async answer failed, it waits for the next turn: ${messageOf(error)}`);
          hold();
        })
        .finally(() => this.threads.runner.steering.delete(threadId));
      return;
    }
    this.defer(threadId, text);
    if (!this.threads.runner.handles.has(threadId)) this.flushDeferred(threadId);
  }

  private defer(threadId: ThreadId, text: string): void {
    this.deferredAnswers.set(threadId, [...(this.deferredAnswers.get(threadId) ?? []), text]);
  }

  /** The held answers as one prompt, when the thread can take one. */
  flushDeferred(threadId: ThreadId): void {
    const held = this.deferredAnswers.get(threadId);
    const thread = this.core.journal.getThread(threadId);
    if (held === undefined || thread === null || thread.archived) return;
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.threads.runner.handles.has(threadId)) return;
    this.deferredAnswers.delete(threadId);
    try {
      this.threads.startTurn(threadId, held.join('\n\n'));
    } catch (error) {
      // Kept for the next prompt the user sends, which carries them first.
      this.deferredAnswers.set(threadId, held);
      this.core.log('warn', `thread ${threadId}: async answers wait for the next prompt: ${messageOf(error)}`);
    }
  }

  /** What was held and never sent: it goes in front of the next prompt. */
  takeDeferred(threadId: ThreadId): string {
    const held = this.deferredAnswers.get(threadId);
    if (held === undefined) return '';
    this.deferredAnswers.delete(threadId);
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
