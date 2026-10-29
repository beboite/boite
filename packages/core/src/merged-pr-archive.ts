import type { ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import { linkedPullRequestSignature } from './linked-pull-requests.ts';
import { archiveState, archiveStateKey } from './merged-pr-archive-state.ts';
import { repositoryOf, type PullRequests } from './pull-requests.ts';

const ARCHIVE_SCAN_ROWS = 128;
const ARCHIVE_PROOFS = 8;
const ARCHIVE_YIELD_ROWS = 8;
/** A merge can happen elsewhere without changing the conversation. Check again next minute. */
const NEGATIVE_RETRY_MS = 60_000;
const NEGATIVE_ENTRIES = 2_000;

/** What a thread looked like when its proof failed: any update or new PR link starts over. */
interface Negative { signature: string; nextAt: number }

/** Visibility maintenance owns one timer and one bounded, non-overlapping pass. */
export class MergedPrArchive {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<number> | null = null;
  #controller: AbortController | null = null;
  #closed = false;
  #cursor = 0;
  #scanEnd = 0;
  /** Threads whose last proof found nothing, so each lap does not ask git and GitHub again. */
  #negative = new Map<string, Negative>();
  /** A failed scan must not delay the first detected merge, or replace a detection's retry deadline. */
  readonly #detectedNegative = new Map<string, Negative>();
  readonly #readyAt: number;
  readonly #detected = new Set<string>();
  #detection: Promise<void> | null = null;
  readonly #detectionController = new AbortController();
  readonly #unlisten: () => void;
  #core: Core;
  #pullRequests: PullRequests;
  #settleMs: number;

  constructor(core: Core, pullRequests: PullRequests, settleMs = 60_000, graceMs = 90_000) { this.#core = core; this.#pullRequests = pullRequests; this.#settleMs = settleMs;
    this.#readyAt = Date.now() + graceMs;
    this.#unlisten = core.bus.onCommitted((name, payload) => {
      if (name !== 'threads.pullRequestsChanged') return;
      const event = payload as { threadId: string; pullRequests: { state: string }[] };
      if (event.pullRequests.some(pr => pr.state === 'MERGED')) this.observe(event.threadId);
    });
  }
  /** A badge or watch already detected the merge. Check this thread without waiting for the history scan. */
  observe(threadId: string): void {
    if (this.#closed) return;
    this.#detected.add(threadId);
    this.#detection ??= this.#drainDetected().finally(() => {
      this.#detection = null;
      const next = this.#detected.values().next().value;
      if (next !== undefined) this.observe(next);
    });
  }
  async #drainDetected(): Promise<void> {
    // Coalesce badge and linked-PR notifications, and leave their RPC free to return.
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const id of this.#detected) {
      this.#detected.delete(id);
      if (this.#closed || this.#core.journal.isClosed()) return;
      try {
        const thread = this.#core.journal.getThread(id);
        if (!thread || this.#backingOff(thread, true) || !this.eligible(thread, true)) continue;
        const signal = AbortSignal.any([this.#detectionController.signal, AbortSignal.timeout(30_000)]);
        await this.#archive(thread, signal, true);
      } catch {
        if (!this.#closed && !this.#core.journal.isClosed()) this.#core.log('warn', 'Merged PR detection failed; conversation remains visible', { source: 'merged-pr-archive', event: 'archive.detectionFailed', threadId: id });
      }
    }
  }
  start(): void {
    const run = (): void => {
      if (this.#closed) return;
      this.#timer = setTimeout(() => { void this.sweep().catch(() => {
        this.#core.log('warn', 'Merged PR archive sweep failed; conversations remain visible', { source: 'merged-pr-archive', event: 'archive.sweepFailed' });
      }).finally(run); }, Math.max(1, this.#readyAt - Date.now(), 60_000));
      this.#timer.unref();
    };
    run();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#unlisten();
    this.#detected.clear();
    this.#detectionController.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#controller?.abort();
    await this.#pending;
    await this.#detection;
    if (this.#timer) clearTimeout(this.#timer);
  }
  eligible(thread: ThreadSummary, detected = false): boolean {
    return this.#eligibleWithScheduler(thread, this.#busyThreads(), detected);
  }
  #eligibleWithScheduler(thread: ThreadSummary, busy: ReadonlySet<string>, detected = false): boolean {
    const core = this.#core;
    if (this.#closed || (!detected && Date.now() < this.#readyAt) || core.stopping || core.threads.handoff.active || core.threads.isRemoving(thread.id)) return false;
    if (thread.archived || thread.parentThreadId || thread.agentSessionId || !thread.projectId || !thread.branch || thread.branch === 'HEAD' || thread.branchNamingPending) return false;
    const project = core.journal.getProject(thread.projectId);
    if (!project || project.archived || project.path === thread.cwd || core.journal.getSetting(`project-auto-archive-merged-pr:${project.id}`) === false) return false;
    if (!this.#quiescent(thread, busy, false, detected)) return false;
    // Retained children remain history. Every visible or archived member must
    // have completed and delivered its work before the parent can reach Done.
    const children = core.journal.db.query('WITH RECURSIVE family(id) AS (SELECT id FROM threads WHERE parent_thread_id = ? UNION SELECT child.id FROM threads child JOIN family ON child.parent_thread_id = family.id) SELECT id FROM family WHERE id <> ? AND id NOT IN (SELECT thread_id FROM thread_deletions)').all(thread.id, thread.id) as { id: string }[];
    if (children.some(({ id }) => { const child = core.journal.getThread(id); return !child || !this.#quiescent(child, busy, true, detected); })) return false;
    const repository = repositoryOf(thread.cwd);
    const holders = core.journal.db.query('SELECT id, cwd, project_id FROM threads WHERE branch = ? AND parent_thread_id IS NULL AND agent_session_id IS NULL').all(thread.branch) as { id: string; cwd: string; project_id: string | null }[];
    return holders.filter(row => row.project_id === thread.projectId || repositoryOf(row.cwd) === repository).length === 1;
  }
  #quiescent(thread: ThreadSummary, busy: ReadonlySet<string>, child = false, detected = false): boolean {
    const core = this.#core;
    const finishing = detected && !child && thread.status === 'running';
    // Reading or viewing completed work is not pending work. Keep unread history in Done.
    if (core.threads.isRemoving(thread.id) || thread.agentSessionId || (thread.status !== 'idle' && !finishing) || thread.pinned || (!detected && Date.now() - thread.updatedAt < this.#settleMs) || core.threads.focus.hasProtectedInput(thread.id)) return false;
    if (core.threads.sideQuestions.active(thread.id) || (!finishing && (core.threads.runner.handles.has(thread.id) || core.threads.runner.steering.has(thread.id) || core.threads.agentState.background.get(thread.id)?.length)) || core.threads.moves.pendingOf(thread.id)) return false;
    if (!finishing && busy.has(thread.id)) return false;
    if ((!finishing && core.procs.liveCount(thread.id)) || core.terminals.threadProcesses(thread.id) || core.threads.cards.listPermissions(thread.id).length || [...core.threads.cards.questions.values()].some(entry => entry.request.threadId === thread.id) || [...core.threads.cards.asyncCards.values()].some(entry => entry.threadId === thread.id)) return false;
    if (core.threads.deferred.deferredAnswers.get(thread.id)?.length || core.threads.deferred.consumed.has(thread.id) || core.threads.deferred.pendingWakes.has(thread.id)) return false;
    const activity = core.activity.get(thread.id);
    if ((activity.goal && activity.goal.status !== 'complete') || (activity.loop && activity.loop.status !== 'complete') || core.workflows.active(thread.id)) return false;
    if (core.journal.db.query("SELECT 1 FROM workflow_runs WHERE root_id = ? AND status IN ('done', 'failed') AND json_extract(data, '$.delivered') IS NOT 1 LIMIT 1").get(thread.id)) return false;
    const last = core.journal.db.query('SELECT status FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1').get(thread.id) as { status: string } | null;
    if ((child && !last) || (last && last.status !== 'done' && !(finishing && last.status === 'running'))) return false;
    if (core.journal.db.query("SELECT 1 FROM delegation_messages WHERE root_id = ? AND status NOT IN ('delivered', 'expired', 'rejected') LIMIT 1").get(thread.id) || core.journal.db.query("SELECT 1 FROM coordination_letters WHERE thread_id = ? AND status NOT IN ('delivered', 'expired', 'rejected') LIMIT 1").get(thread.id) || core.journal.db.query('SELECT 1 FROM coordination_wakes WHERE thread_id = ? LIMIT 1').get(thread.id)) return false;
    return true;
  }
  sweep(): Promise<number> {
    if (this.#closed || this.#core.journal.isClosed()) return Promise.resolve(0);
    if (this.#pending) return this.#pending;
    const controller = new AbortController();
    this.#controller = controller;
    const deadline = setTimeout(() => controller.abort(), 30_000);
    deadline.unref();
    this.#pending = this.#pass(controller.signal).finally(() => {
      clearTimeout(deadline);
      this.#controller = null;
      this.#pending = null;
    });
    return this.#pending;
  }
  #busyThreads(): ReadonlySet<string> {
    const state = this.#core.scheduler.state();
    return new Set([...state.running, ...state.queued].map(entry => entry.threadId));
  }
  async #select(signal: AbortSignal): Promise<ThreadSummary[]> {
    if (this.#closed || signal.aborted || this.#core.journal.isClosed()) return [];
    if (Date.now() < this.#readyAt || this.#core.stopping || this.#core.threads.handoff.active) return [];
    if (!this.#scanEnd) {
      this.#scanEnd = (this.#core.journal.db.query('SELECT MAX(rowid) AS last FROM threads').get() as { last: number | null }).last ?? 0;
    }
    // LIMIT bounds physical rows, including blocked and deleted roots. Filtering
    // before LIMIT would scan the entire database when qualifying roots are sparse.
    const rows = this.#core.journal.db.query(`SELECT rowid, id,
      archived = 0 AND parent_thread_id IS NULL AND agent_session_id IS NULL
      AND project_id IS NOT NULL AND branch IS NOT NULL AND branch NOT IN ('', 'HEAD')
      AND COALESCE(branch_naming_pending, 0) = 0 AND status = 'idle' AND pinned = 0
      AND updated_at <= ? AND NOT EXISTS (SELECT 1 FROM thread_deletions WHERE thread_id = threads.id) AS candidate
      FROM threads WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`)
      .all(Date.now() - this.#settleMs, this.#cursor, this.#scanEnd, ARCHIVE_SCAN_ROWS) as { rowid: number; id: string; candidate: number | null }[];
    const selected: ThreadSummary[] = [];
    let busy: ReadonlySet<string> | undefined;
    for (let index = 0; index < rows.length; index++) {
      if (index % ARCHIVE_YIELD_ROWS === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
        busy = undefined;
      }
      if (this.#closed || signal.aborted || this.#core.journal.isClosed()) break;
      const row = rows[index]!;
      this.#cursor = row.rowid;
      if (!row.candidate) continue;
      const thread = this.#core.journal.getThread(row.id);
      if (!thread || this.#backingOff(thread) || !this.#eligibleWithScheduler(thread, busy ??= this.#busyThreads())) continue;
      selected.push(thread);
      if (selected.length === ARCHIVE_PROOFS) break;
    }
    if (this.#cursor >= this.#scanEnd || rows.length === 0 || (rows.length < ARCHIVE_SCAN_ROWS && this.#cursor === rows.at(-1)!.rowid)) {
      this.#cursor = 0;
      this.#scanEnd = 0;
    }
    return selected;
  }
  #signature(thread: ThreadSummary): string {
    return `${thread.updatedAt}\n${linkedPullRequestSignature(this.#core.journal, thread.id)}`;
  }
  #backingOff(thread: ThreadSummary, detected = false): boolean {
    const entry = (detected ? this.#detectedNegative : this.#negative).get(thread.id);
    return entry !== undefined && entry.signature === this.#signature(thread) && Date.now() < entry.nextAt;
  }
  /** Suppress repeated reads within one round, without delaying an external merge for an hour. */
  #remember(thread: ThreadSummary, signature: string, detected = false): void {
    const entries = detected ? this.#detectedNegative : this.#negative;
    entries.delete(thread.id);
    entries.set(thread.id, { signature, nextAt: Date.now() + NEGATIVE_RETRY_MS });
    if (entries.size > NEGATIVE_ENTRIES) entries.delete(entries.keys().next().value!);
  }
  async #pass(signal: AbortSignal): Promise<number> {
    let archived = 0;
    const deadline = Date.now() + 30_000;
    const selected = await this.#select(signal);
    for (const thread of selected) {
      if (Date.now() >= deadline || this.#closed || signal.aborted || this.#core.journal.isClosed()) break;
      if (await this.#archive(thread, signal)) archived++;
    }
    return archived;
  }
  async #archive(thread: ThreadSummary, signal: AbortSignal, detected = false): Promise<boolean> {
    const generation = archiveState(this.#core.journal, thread.id).generation;
    const signature = this.#signature(thread);
    try {
      const proof = await archiveRead(this.#pullRequests.proveMerged(thread, signal), signal);
      if (this.#closed || signal.aborted || this.#core.journal.isClosed()) return false;
      if (!proof) { this.#remember(thread, signature, detected); return false; }
      const current = this.#core.journal.getThread(thread.id);
      if (!current || (!detected && current.updatedAt !== thread.updatedAt) || !this.eligible(current, detected) || archiveState(this.#core.journal, thread.id).generation !== generation) return false;
      const state = archiveState(this.#core.journal, thread.id);
      const restored = state.restoredCheckout;
      if (state.dismissed?.includes(proof.url) || (restored && restored.cwd === thread.cwd && restored.branch === thread.branch && restored.projectId === thread.projectId)) { this.#remember(thread, signature, detected); return false; }
      this.#core.journal.setSetting(archiveStateKey(thread.id), { ...state, binding: proof });
      if (!await archiveRead(this.#pullRequests.validateMergedCheckout(thread, proof, signal), signal)) { this.#remember(thread, signature, detected); return false; }
      if (this.#closed || signal.aborted || this.#core.journal.isClosed()) return false;
      // No await between the final state check and the visibility transaction.
      if (this.#core.threads.archiveMergedPr(thread, proof, generation, detected)) { this.#negative.delete(thread.id); this.#detectedNegative.delete(thread.id); return true; }
    } catch {
      // Missing auth, unavailable repositories and failed validation leave the conversation visible.
      if (!signal.aborted && !this.#closed) this.#remember(thread, signature, detected);
    }
    return false;
  }
}

/** A late provider result cannot resume a closed pass, even if it ignored cancellation. */
function archiveRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const canceled = (): void => { reject(new Error('merged PR archive pass canceled')); };
    signal.addEventListener('abort', canceled, { once: true });
    pending.then(value => {
      signal.removeEventListener('abort', canceled);
      if (!signal.aborted) resolve(value);
    }, error => {
      signal.removeEventListener('abort', canceled);
      if (!signal.aborted) reject(error);
    });
    if (signal.aborted) canceled();
  });
}
