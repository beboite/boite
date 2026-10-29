import type { ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { withLoad } from '../threads/records.ts';

const KEY = 'delegation-retiring:';
/** A retired subagent the user reopened by hand, with the last turn it had then: it stays open until another turn ends. */
const KEPT = 'delegation-kept:';

/**
 * A subagent is put away as done once it is over, so a conversation does not
 * keep every agent it ever started open:
 * - a delegated agent whose last turn ended done, once that result reached its parent;
 * - a workflow step's conversation, once its run is done.
 * A persistent agent's next episode also archives the subagents of the last one.
 * One still watching its pull request is kept, with a marker when an episode
 * asked, and retires once the watch and its turn are over and its last result
 * reached the parent: a result not yet created would never be sent.
 *
 * A stopped or failed one stays, for `delegate resume`, and so does the rest of
 * an archived conversation's family, which its restore brings back as it was. A retired one carries
 * `doneAt`: its parent writing to it again brings it back (`revive`). One the
 * user reopens stays open until its next turn ends (`keep`).
 */
export class Retirements {
  readonly #core: Core;
  readonly #working: (thread: ThreadSummary) => boolean;
  readonly #lastTurn: (threadId: string) => Turn | null;

  constructor(core: Core, working: (thread: ThreadSummary) => boolean, lastTurn: (threadId: string) => Turn | null) {
    this.#core = core; this.#working = working; this.#lastTurn = lastTurn;
  }

  /** Archives the subagent now, or keeps it for the watch it still holds. */
  begin(child: ThreadSummary, episodeId: string): void {
    if (this.#core.pullRequestWatches.of(child.id).length) this.#core.journal.setSetting(KEY + child.id, episodeId);
    else this.#retire(child);
  }

  /** Retires a subagent that is over: on its updates, on each of its letters handed over and on its run's end. */
  check(threadId: string): void {
    const marked = this.#core.journal.getSetting(KEY + threadId) !== undefined;
    const thread = this.#core.journal.getThread(threadId);
    if (!thread?.parentThreadId || thread.archived) { if (marked) this.#core.journal.deleteSetting(KEY + threadId); return; }
    if (this.#working(thread) || this.#core.pullRequestWatches.of(threadId).length) return;
    // Its background work just ended and it gets a moment to wake on it, an answer
    // waits for its turn to end, a question waits for the user, or a retry is due.
    const load = withLoad(this.#core, thread);
    if (load.backgroundWait?.state === 'waiting' || load.pendingAnswers?.length || load.openQuestions || load.retry) return;
    const turn = this.#lastTurn(threadId);
    const kept = this.#core.journal.getSetting(KEPT + threadId) as string | undefined;
    if (kept !== undefined) {
      if (kept === (turn?.id ?? '')) return;
      this.#core.journal.deleteSetting(KEPT + threadId);
    }
    const told = (sql: string, ...args: string[]) => this.#core.journal.db.query(sql).get(threadId, ...args) !== null;
    // Mail its parent sent it is more work.
    if (told("SELECT 1 FROM delegation_messages WHERE recipient_id = ? AND status IN ('received', 'uncertain') LIMIT 1")) return;
    if (this.#core.workflows.owns(threadId)) {
      // A failed or stopped run may retry the step in its own conversation.
      const run = this.#core.journal.db.query('SELECT r.status FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id WHERE s.thread_id = ?').get(threadId) as { status: string } | null;
      if (run?.status === 'done') this.#retire(thread);
      return;
    }
    if (!marked && !this.#finished(thread, turn)) return;
    if (turn && !told('SELECT 1 FROM delegation_messages WHERE sender_id = ? AND request_id = ?', `result:${turn.id}`)) return;
    if (told("SELECT 1 FROM delegation_messages WHERE sender_id = ? AND status IN ('received', 'uncertain') LIMIT 1")) return;
    this.#retire(thread);
  }

  /**
   * On start: a restart between a kept subagent's last delivery and its archive
   * retires it, and so does every subagent left over by a core that kept them
   * all. One that fails waits for its next update.
   */
  sweep(): void {
    const marked = (this.#core.journal.db.query(`SELECT key FROM settings WHERE key GLOB '${KEY}*'`).all() as { key: string }[]).map(({ key }) => key.slice(KEY.length));
    const open = (this.#core.journal.db.query("SELECT id FROM threads WHERE archived = 0 AND parent_thread_id IS NOT NULL AND parent_thread_id <> ''").all() as { id: string }[]).map(row => row.id);
    for (const threadId of new Set([...marked, ...open])) {
      try { this.check(threadId); } catch (error) {
        this.#core.logs.record('warn', `Retiring subagent ${threadId} on start failed: ${messageOf(error)}`, { source: 'delegation', event: 'delegation.retire_failed', threadId });
      }
    }
  }

  /** A run changed. Emitted for the root and for each step: the root's announcement is enough. */
  runChanged({ threadId, runId }: { threadId: string; runId: string }): void {
    if (!this.#core.journal.getThread(threadId)?.parentThreadId) this.checkRun(runId);
  }
  /** The steps of a run that just ended done. */
  checkRun(runId: string): void {
    for (const { thread_id } of this.#core.journal.db.query("SELECT s.thread_id FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id JOIN threads t ON t.id = s.thread_id WHERE s.run_id = ? AND r.status = 'done' AND t.archived = 0").all(runId) as { thread_id: string }[]) this.check(thread_id);
  }

  /** The user reopened a retired subagent: it stays open until its next turn ends. */
  keep(threadId: string): void {
    this.#core.journal.setSetting(KEPT + threadId, this.#lastTurn(threadId)?.id ?? '');
  }

  /** Whether the inbox skips a sender's letters: one archived by hand, not one put away as done. */
  silent(threadId: string): boolean {
    const sender = this.#core.journal.getThread(threadId);
    return sender?.archived === true && sender.doneAt == null;
  }

  /** A subagent put away as done, whose parent is not, comes back when its parent or the user writes to it. */
  revivable(child: ThreadSummary): boolean {
    if (!child.archived || !child.parentThreadId || child.doneAt == null || this.#core.threads.isRemoving(child.id)) return false;
    return this.#core.journal.getThread(child.parentThreadId)?.archived === false;
  }

  /**
   * Opens a retired subagent again for `work`, the letter or turn that keeps it
   * open: announced only after it, so the retirement check this update runs
   * does not find it idle and put it away again.
   */
  revive<T>(child: ThreadSummary, work: () => T): T {
    this.#core.journal.putThread({ ...child, archived: false, doneAt: null, archivedAt: null, updatedAt: Date.now() });
    try { return work(); } finally {
      const thread = this.#core.journal.getThread(child.id);
      if (thread) this.#core.bus.emit('thread.updated', thread);
    }
  }

  /** A delegated agent that ended its work done, rather than stopped, failed or cut from its background work. */
  #finished(thread: ThreadSummary, turn: Turn | null): boolean {
    if (turn?.status !== 'done' || this.#core.journal.db.query('SELECT 1 FROM delegated_agents WHERE thread_id = ?').get(thread.id) === null) return false;
    return withLoad(this.#core, thread).backgroundWait?.state !== 'interrupted';
  }

  #retire(child: ThreadSummary): void {
    this.#core.journal.deleteSetting(KEY + child.id);
    this.#core.journal.deleteSetting(KEPT + child.id);
    this.#core.threads.releaseAgent(child.id);
    const now = Date.now();
    const archived = { ...child, archived: true, doneAt: now, archivedAt: now, updatedAt: now };
    this.#core.journal.putThread(archived);
    this.#core.bus.emit('thread.updated', archived);
  }
}
