import type { MemoryEvent } from '@boite/contracts';
import type { Core } from '../core.ts';
import { newId } from '../ids.ts';
import { memoryNotice } from '../memory-guard.ts';
import type { ThreadStore } from '../threads.ts';

interface Notice { id: string; text: string }

/** Durable until delivered, without opening a turn just to report pressure. */
export class MemoryNotices {
  private readonly sending = new Set<string>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {
    core.bus.onAny((name, payload) => {
      if (name === 'resources.memory') this.record(payload as MemoryEvent);
    });
  }

  private key(threadId: string): string { return `memory-notices:${threadId}`; }

  private pending(threadId: string): Notice[] {
    return (this.core.journal.getSetting(this.key(threadId)) as Notice[] | null) ?? [];
  }

  private remove(threadId: string, ids: Set<string>): void {
    if (this.core.journal.isClosed()) return;
    const pending = this.pending(threadId).filter(notice => !ids.has(notice.id));
    if (pending.length) this.core.journal.setSetting(this.key(threadId), pending);
    else this.core.journal.deleteSetting(this.key(threadId));
  }

  private record(event: MemoryEvent): void {
    const threadId = event.threadId;
    if (threadId === null || this.core.journal.isClosed() || this.core.journal.getThread(threadId) === null) return;
    const message = this.core.journal.listMessagePage(threadId, { limit: 1 }).messages.at(-1);
    if (message?.role === 'assistant' && message.state === 'streaming') {
      event = { ...event, anchor: { messageId: message.id, partIndex: message.parts.length } };
    }
    const notice = { id: newId('mem_'), text: memoryNotice(event) };
    this.core.journal.append({ type: 'thread.memory', threadId, version: 1, payload: event, ts: event.at }, () => {
      this.core.journal.setSetting(this.key(threadId), [...this.pending(threadId), notice]);
    });
    this.core.bus.emit('thread.memory', { ...event, threadId });
    void this.flushRunning(threadId);
  }

  async flushRunning(threadId: string): Promise<void> {
    const runner = this.threads.runner;
    const handle = runner.handles.get(threadId);
    if (!handle?.steer || runner.steering.has(threadId)) return;
    runner.steering.add(threadId);
    try {
      // More than one limit event can arrive while the driver's steer is out.
      for (;;) {
        if (this.core.journal.isClosed() || runner.handles.get(threadId) !== handle) break;
        const notice = this.pending(threadId).find(item => !this.sending.has(item.id));
        if (notice === undefined) break;
        this.sending.add(notice.id);
        try {
          if (!await handle.steer(notice.text)) break;
          this.remove(threadId, new Set([notice.id]));
        } finally {
          this.sending.delete(notice.id);
        }
      }
    } catch (error) {
      this.core.log('warn', `thread ${threadId}: memory notice waits for the next turn: ${String(error)}`);
    } finally {
      runner.steering.delete(threadId);
    }
  }

  /** The same queue feeds a tool-boundary pull or the next turn's system note. */
  take(threadId: string): string {
    const held = this.pending(threadId).filter(notice => !this.sending.has(notice.id));
    if (!held.length) return '';
    this.remove(threadId, new Set(held.map(notice => notice.id)));
    return held.map(notice => notice.text).join('\n\n') + '\n\n';
  }
}
