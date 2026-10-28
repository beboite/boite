import type { ThreadId } from '@boite/contracts';
import type { Store } from './store.svelte';

/**
 * One rename of one thread: the machine and thread it began on, and the text being typed.
 * The title it commits always goes to that thread, whatever the screen shows by then,
 * and only once: Enter, then the blur of the input it removes, writes a single title.
 */
export class ThreadRename {
  text = $state('');
  #settled = false;

  constructor(
    readonly store: Store,
    readonly threadId: ThreadId,
    title: string
  ) {
    this.text = title;
  }

  /** The rename has not been committed or cancelled yet. */
  get active(): boolean {
    return !this.#settled;
  }

  async commit(): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    await this.store.rename(this.threadId, this.text);
  }

  cancel(): void {
    this.#settled = true;
  }
}
