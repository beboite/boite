/**
 * What the sync is doing, and what it is waiting on.
 *
 * Progress is polled rather than pushed, because the backend leaves snapshots
 * rather than emitting events: one path serves the desktop and a phone talking
 * to a `boite-server`, and a panel opened half way through a fetch sees where it
 * got to rather than an empty bar nobody buffered.
 *
 * **Nothing in this file imports `@codemirror/*`, and nothing may.** The merge
 * view is behind a dynamic import and every CodeMirror package in this app is
 * reachable only that way. This store is on the boot graph — the launch pull
 * needs it — so one import here would drag the whole editor stack into the eager
 * bundle, which is ten times the headroom the budget has. `eager.test.ts`
 * asserts it rather than leaving it to a comment.
 */

import { backend } from "$lib/backend";
import type { Backend, SyncConflict, SyncSource, SyncStatus } from "$lib/backend";
import { settings } from "$lib/features/settings/store.svelte";

const POLL_MS = 500;
/**
 * How many answers may go missing before the panel stops claiming to know.
 *
 * A bar that says "fetching" for ever is worse than an honest "this panel no
 * longer knows what happened".
 */
const POLL_MISSES_ALLOWED = 3;

/** What the user decided about one file, once it has been acted on. */
export type Verdict = "resolved" | "skipped" | "failed";

class SyncStore {
  status = $state<SyncStatus | null>(null);
  sources = $state<SyncSource[]>([]);
  conflicts = $state<SyncConflict[]>([]);
  verdicts = $state<Record<string, Verdict>>({});
  /** Which file the merge tool is showing. Null while it is closed. */
  activePath = $state<string | null>(null);
  mergeOpen = $state(false);
  loading = $state(false);
  /**
   * State the panel keeps reporting, rendered in place rather than as a toast.
   * A repository that will not answer is not an action the user just took.
   */
  error = $state<string | null>(null);

  /**
   * Which transport answered.
   *
   * Every await is followed by a check against this: a workspace switch mid-call
   * would otherwise land another machine's answer — and another machine's
   * `~/.claude` — in this panel.
   */
  #answeredBy: Backend | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #misses = 0;
  /**
   * Which backends have had their launch pull.
   *
   * Identity rather than a boolean: a workspace grafted twelve seconds after
   * boot gets its own pull, and the local one is not repeated.
   */
  #pulledAtLaunch = new WeakSet<Backend>();

  /** Whether a run is going on, which is also what keeps the poll scheduled. */
  get busy(): boolean {
    const phase = this.status?.job.phase;
    if (!phase) return false;
    return !["idle", "done", "needsMerge", "failed", "cancelled"].includes(phase);
  }

  /** Files still waiting on a person. */
  get pending(): number {
    return this.conflicts.filter((item) => !this.verdicts[item.path]).length;
  }

  get remoteUrl(): string | null {
    return this.status?.remoteUrl ?? settings.state.syncRemoteUrl;
  }

  /** The rows the panel draws, loaded once per transport. */
  async ensure(): Promise<void> {
    if (this.#answeredBy === backend() && this.sources.length > 0) {
      await this.#pollOnce();
      return;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    this.loading = true;
    try {
      const [sources, status, conflicts] = await Promise.all([
        from.sync.sources(),
        from.sync.status(),
        from.sync.conflicts(),
      ]);
      if (this.#answeredBy !== from) return;
      this.sources = sources;
      this.status = status;
      this.conflicts = conflicts;
      this.error = null;
      this.#misses = 0;
    } catch (error) {
      if (this.#answeredBy !== from) return;
      this.error = messageOf(error);
    } finally {
      if (this.#answeredBy === from) this.loading = false;
    }
    this.#schedule();
  }

  /** The button. Fetches, compares, and opens the merge tool if it has to. */
  async syncNow(): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    this.error = null;
    try {
      const conflicts = await from.sync.pull();
      if (this.#answeredBy !== from) return;
      this.conflicts = conflicts;
      this.verdicts = {};
      if (conflicts.length > 0) this.openMerge(conflicts[0].path);
      this.#schedule();
    } catch (error) {
      if (this.#answeredBy !== from) return;
      this.error = messageOf(error);
    }
  }

  /**
   * The pull a launch does.
   *
   * Takes what only the other side changed and sends nothing, so opening Boite
   * never publishes on its own. Failing here is silent on purpose: an app that
   * opens on an error dialogue because the wifi is off is worse than one that
   * says so in the settings panel.
   */
  async pullAtLaunch(): Promise<void> {
    if (!settings.state.syncOnLaunch || !settings.state.syncRemoteUrl) return;
    const from = backend();
    if (this.#pulledAtLaunch.has(from)) return;
    this.#pulledAtLaunch.add(from);
    this.#answeredBy = from;
    try {
      const conflicts = await from.sync.pull();
      if (this.#answeredBy !== from) return;
      this.conflicts = conflicts;
      this.verdicts = {};
      if (conflicts.length > 0) this.openMerge(conflicts[0].path);
      this.#schedule();
    } catch (error) {
      if (this.#answeredBy !== from) return;
      this.error = messageOf(error);
    }
  }

  /**
   * One file settled with the bytes the user is looking at.
   *
   * Durable the moment it answers, which is what makes walking away from a
   * half-finished merge safe: every file was either applied — holding exactly
   * what was on screen — or never touched.
   */
  async resolve(path: string, content: string): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    try {
      const job = await from.sync.resolve(path, content);
      if (this.#answeredBy !== from) return;
      this.status = this.status ? { ...this.status, job } : this.status;
      this.verdicts = { ...this.verdicts, [path]: "resolved" };
      this.#advance(path);
    } catch (error) {
      if (this.#answeredBy !== from) return;
      // One file's failure, not the run's: the rest are still waiting and still
      // safe to decide.
      this.verdicts = { ...this.verdicts, [path]: "failed" };
      this.error = messageOf(error);
    }
  }

  /** Left as both sides have it. The next pull asks again. */
  async skip(path: string): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    try {
      const job = await from.sync.skip(path);
      if (this.#answeredBy !== from) return;
      this.status = this.status ? { ...this.status, job } : this.status;
      this.verdicts = { ...this.verdicts, [path]: "skipped" };
      this.#advance(path);
    } catch (error) {
      if (this.#answeredBy !== from) return;
      this.verdicts = { ...this.verdicts, [path]: "failed" };
      this.error = messageOf(error);
    }
  }

  /** Sends what this machine settled. The one call that reaches the network. */
  async push(): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    this.error = null;
    try {
      const job = await from.sync.push();
      if (this.#answeredBy !== from) return;
      this.status = this.status ? { ...this.status, job } : this.status;
      this.#schedule();
    } catch (error) {
      if (this.#answeredBy !== from) return;
      this.error = messageOf(error);
    }
  }

  async probe(url: string) {
    return backend().sync.probe(url);
  }

  async dismiss(): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    try {
      await from.sync.dismiss();
      if (this.#answeredBy !== from) return;
      this.error = null;
      await this.refresh();
    } catch (error) {
      if (this.#answeredBy === from) this.error = messageOf(error);
    }
  }

  async repair(): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    try {
      await from.sync.repair();
      if (this.#answeredBy !== from) return;
      this.error = null;
    } catch (error) {
      if (this.#answeredBy === from) this.error = messageOf(error);
    }
  }

  openMerge(path: string | null): void {
    this.activePath = path ?? this.conflicts[0]?.path ?? null;
    this.mergeOpen = this.activePath !== null;
  }

  /**
   * Closes the merge tool without deciding anything else.
   *
   * Nothing is rolled back. Rolling back a file that was applied would be the
   * overwrite this feature does not do, in the other direction, and whatever was
   * never decided is untouched on both sides — so the next pull finds it and
   * asks again.
   */
  closeMerge(): void {
    this.mergeOpen = false;
    this.activePath = null;
  }

  /**
   * Dropped when the workspace changes.
   *
   * A merge for another machine's `~/.claude` is a merge that must not be
   * applied here, so the tool closes rather than carrying on with rows that no
   * longer describe what is on screen.
   */
  forget(): void {
    this.#answeredBy = null;
    this.#stop();
    this.status = null;
    this.sources = [];
    this.conflicts = [];
    this.verdicts = {};
    this.mergeOpen = false;
    this.activePath = null;
    this.error = null;
  }

  #advance(from: string): void {
    const next = this.conflicts.find(
      (item) => item.path !== from && !this.verdicts[item.path],
    );
    if (next) {
      this.activePath = next.path;
      return;
    }
    this.mergeOpen = false;
    this.activePath = null;
  }

  #schedule(): void {
    this.#stop();
    if (!this.busy) return;
    this.#timer = setTimeout(() => void this.#pollOnce(), POLL_MS);
  }

  #stop(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #pollOnce(): Promise<void> {
    const from = backend();
    if (this.#answeredBy !== from) return;
    try {
      const status = await from.sync.status();
      if (this.#answeredBy !== from) return;
      this.status = status;
      this.#misses = 0;
      if (status.job.phase === "needsMerge") {
        const conflicts = await from.sync.conflicts();
        if (this.#answeredBy !== from) return;
        this.conflicts = conflicts;
        if (conflicts.length > 0 && !this.mergeOpen) this.openMerge(conflicts[0].path);
      }
    } catch (error) {
      if (this.#answeredBy !== from) return;
      this.#misses += 1;
      if (this.#misses >= POLL_MISSES_ALLOWED) this.#failLocally(messageOf(error));
    }
    this.#schedule();
  }

  /**
   * Says the panel stopped knowing, without inventing what happened.
   *
   * What it had got to is kept: "it stopped at 40 of 60" and "it stopped" are
   * different things to read.
   */
  #failLocally(message: string): void {
    this.error = message;
    if (!this.status) return;
    this.status = {
      ...this.status,
      job: { ...this.status.job, phase: "failed", message },
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const syncStore = new SyncStore();
