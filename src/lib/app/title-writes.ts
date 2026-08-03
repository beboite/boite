import { updateThreadTitle } from "$lib/storage/db";
import { logger } from "$lib/shared/services/logger.svelte";
import type { WorkspaceOrigin } from "$lib/types";

/**
 * How long a title sits before it is written.
 *
 * A fixed window rather than a trailing debounce, and that is the whole design:
 * an agent streaming tokens rewrites the OSC title continuously, and a trailing
 * debounce would never fire until the agent stopped talking. A fixed window
 * writes once every half second however long the burst runs.
 */
const WINDOW_MS = 500;

/**
 * Coalesces title writes so an agent's output does not become a write per token.
 *
 * Only the title column is written, never the row: a flush lands up to half a
 * second late, and writing the whole row then would clobber whatever the status
 * engine or a rename did in between.
 *
 * The origin of a thread is asked for at flush time rather than remembered with
 * the title, because a thread can move workspace between the write and the
 * flush and the row it has to reach is the one it is in now.
 */
export class TitleWrites {
  #pending = new Map<string, string | null>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private originOf: (threadId: string) => WorkspaceOrigin | undefined) {}

  queue(threadId: string, title: string | null) {
    this.#pending.set(threadId, title);
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#write(this.#take());
    }, WINDOW_MS);
  }

  /**
   * Writes everything queued, now.
   *
   * Called before anything that ends the process on purpose — applying an
   * update — because the window is otherwise long enough to lose the last title
   * of every thread.
   */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#write(this.#take());
  }

  /**
   * Forgets a queued title for one thread.
   *
   * A manual rename calls it: an OSC title queued half a second before would
   * otherwise land on top of the name the user just typed.
   */
  cancel(threadId: string) {
    this.#pending.delete(threadId);
  }

  /** Drops what is queued without writing it. For a workspace switch. */
  discard() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending.clear();
  }

  #take(): [string, string | null][] {
    const batch = [...this.#pending];
    this.#pending.clear();
    return batch;
  }

  async #write(batch: [string, string | null][]): Promise<void> {
    await Promise.all(
      batch.map(([id, title]) =>
        updateThreadTitle(id, title, this.originOf(id)).catch((err) => {
          logger.error("app", "updateThreadTitle failed", err);
        }),
      ),
    );
  }
}
