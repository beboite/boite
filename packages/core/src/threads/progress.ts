import type { ThreadId, ThreadProgress, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { withLoad } from './records.ts';

/** One latest event per active turn. Streaming timestamps update without a write per delta. */
export class ProgressState {
  private readonly latest = new Map<ThreadId, ThreadProgress>();
  private readonly published = new Map<ThreadId, number>();
  /**
   * The turns `latest` names that the journal last wrote as running. Every
   * status change goes through `putTurn`, so a delta checks this set instead of
   * reading its turn row back.
   */
  private readonly running = new Set<TurnId>();

  constructor(private readonly core: Core) {
    core.journal.onTurnWritten(turn => this.written(turn));
  }

  begin(threadId: ThreadId, turnId: TurnId): void {
    const old = this.latest.get(threadId);
    if (old) this.running.delete(old.turnId);
    const at = Date.now();
    this.latest.set(threadId, { turnId, phase: 'starting', detail: null, at, since: at });
    this.published.delete(threadId);
    // A turn starts queued and turns running in a later write; one already running is read once here.
    if (this.core.journal.getTurn(turnId)?.status === 'running') this.running.add(turnId);
  }

  get(threadId: ThreadId): ThreadProgress | null {
    const progress = this.latest.get(threadId);
    return progress && this.running.has(progress.turnId) ? progress : null;
  }

  report(threadId: ThreadId, turnId: TurnId, phase: ThreadProgress['phase'], detail: string | null = null): void {
    const old = this.latest.get(threadId);
    // A late SDK callback must never overwrite the next turn or revive an ended one.
    if (old?.turnId !== turnId || !this.running.has(turnId)) return;
    const at = Date.now();
    const short = detail?.replace(/\s+/g, ' ').trim().slice(0, 300) || null;
    // A compaction mid-turn shows how long it has run, so a repeated phase keeps its start.
    const since = old.phase === phase ? old.since ?? old.at : at;
    this.latest.set(threadId, { turnId, phase, detail: short, at, since, providerAt: at });
    // Native compaction may start while a merged conversation's last prompt finishes.
    if (phase === 'compacting') this.core.threads.autoCompact.stopIfDone(threadId);
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
    this.running.delete(turnId);
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

  /** A write that ends the turn is final even if its transaction rolls back: a late callback is dropped, never let through. */
  private written(turn: Turn): void {
    if (turn.status !== 'running') this.running.delete(turn.id);
    else if (this.latest.get(turn.threadId)?.turnId === turn.id) this.running.add(turn.id);
  }
}
