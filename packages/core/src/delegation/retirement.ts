import type { ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';

const KEY = 'delegation-retiring:';

/**
 * A persistent agent's next episode archives the subagents of the last one.
 * One still watching its pull request is kept with a marker, and retires once
 * the watch and its turn are over and its last result reached the parent:
 * the parent's inbox skips an archived sender, so a result not yet created or
 * handed over would be lost.
 */
export class Retirements {
  constructor(private readonly core: Core, private readonly working: (thread: ThreadSummary) => boolean, private readonly lastTurn: (threadId: string) => Turn | null) {}

  /** Archives the subagent now, or keeps it for the watch it still holds. */
  begin(child: ThreadSummary, episodeId: string): void {
    if (this.core.pullRequestWatches.of(child.id).length) this.core.journal.setSetting(KEY + child.id, episodeId);
    else this.retire(child);
  }

  /** Retires a kept subagent once it is done: on its updates and on each of its letters handed over. */
  check(threadId: string): void {
    if (this.core.journal.getSetting(KEY + threadId) === undefined) return;
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived) { this.core.journal.deleteSetting(KEY + threadId); return; }
    if (this.working(thread) || this.core.pullRequestWatches.of(threadId).length) return;
    const turn = this.lastTurn(threadId);
    const told = (sql: string, ...args: string[]) => this.core.journal.db.query(sql).get(threadId, ...args) !== null;
    if (turn && !told('SELECT 1 FROM delegation_messages WHERE sender_id = ? AND request_id = ?', `result:${turn.id}`)) return;
    if (told("SELECT 1 FROM delegation_messages WHERE sender_id = ? AND status IN ('received', 'uncertain') LIMIT 1")) return;
    this.retire(thread);
  }

  /** A restart between a kept subagent's last delivery and its archive retires it on start; one that fails waits for its next update. */
  sweep(): void {
    for (const { key } of this.core.journal.db.query(`SELECT key FROM settings WHERE key GLOB '${KEY}*'`).all() as { key: string }[]) {
      const threadId = key.slice(KEY.length);
      try { this.check(threadId); } catch (error) {
        this.core.logs.record('warn', `Retiring subagent ${threadId} on start failed: ${messageOf(error)}`, { source: 'delegation', event: 'delegation.retire_failed', threadId });
      }
    }
  }

  private retire(child: ThreadSummary): void {
    this.core.journal.deleteSetting(KEY + child.id);
    this.core.threads.releaseAgent(child.id);
    const now = Date.now();
    const archived = { ...child, archived: true, archivedAt: now, updatedAt: now };
    this.core.journal.putThread(archived);
    this.core.bus.emit('thread.updated', archived);
  }
}
