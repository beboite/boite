import type { ThreadId, ThreadProgress, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { withLoad } from './records.ts';

/** One latest event per active turn. Streaming timestamps update without a write per delta. */
export class ProgressState {
  private readonly latest = new Map<ThreadId, ThreadProgress>();
  private readonly published = new Map<ThreadId, number>();

  constructor(private readonly core: Core) {}

  begin(threadId: ThreadId, turnId: TurnId): void {
    this.latest.set(threadId, { turnId, phase: 'starting', detail: null, at: Date.now() });
    this.published.delete(threadId);
  }

  get(threadId: ThreadId): ThreadProgress | null {
    const progress = this.latest.get(threadId);
    return progress && this.core.journal.getTurn(progress.turnId)?.status === 'running' ? progress : null;
  }

  report(threadId: ThreadId, turnId: TurnId, phase: ThreadProgress['phase'], detail: string | null = null): void {
    const old = this.latest.get(threadId);
    // A late SDK callback must never overwrite the next turn or revive an ended one.
    if (old?.turnId !== turnId || this.core.journal.getTurn(turnId)?.status !== 'running') return;
    const at = Date.now();
    const short = detail?.replace(/\s+/g, ' ').trim().slice(0, 300) || null;
    this.latest.set(threadId, { turnId, phase, detail: short, at, providerAt: at });
    if (old.phase === phase && old.detail === short && at - (this.published.get(threadId) ?? 0) < 1000) return;
    const thread = this.core.journal.getThread(threadId);
    if (!thread) return;
    this.published.set(threadId, at);
    this.core.bus.emit('thread.updated', withLoad(this.core, thread));
  }

  end(threadId: ThreadId, turnId: TurnId): void {
    if (this.latest.get(threadId)?.turnId !== turnId) return;
    this.latest.delete(threadId);
    this.published.delete(threadId);
  }

  contact(threadId: ThreadId, turnId: TurnId): void {
    const old = this.get(threadId);
    if (!old || old.turnId !== turnId) return;
    const now = Date.now();
    this.latest.set(threadId, { ...old, providerAt: now });
    if (now - (this.published.get(threadId) ?? 0) < 1000) return;
    const thread = this.core.journal.getThread(threadId);
    if (!thread) return;
    this.published.set(threadId, now);
    this.core.bus.emit('thread.updated', withLoad(this.core, thread));
  }
}
