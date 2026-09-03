import { backend } from "$lib/backend";
import type { OrchestratorAction } from "$lib/backend/types";

/**
 * What the orchestrators did, and which of it can still be undone.
 *
 * It used to be local state inside `Inbox.svelte`, which worked until Home
 * started merging the two empty cards into one: the merge rule has to know
 * whether the inbox has anything to show, and an undo offer is something to
 * show, so the list cannot live inside the card the rule decides to draw or
 * not. Loaded on a wake rather than polled, exactly as it was.
 */
class OrchestratorActions {
  rows = $state<OrchestratorAction[]>([]);
  undoing = $state<string | null>(null);

  undoable: OrchestratorAction[] = $derived(
    this.rows.filter((row) => row.undoable && row.undoneAt === null),
  );

  async load(): Promise<void> {
    try {
      this.rows = (await backend().conduct?.actions({ limit: 20 })) ?? [];
    } catch {
      this.rows = [];
    }
  }

  /** Throws what the bus said; the card turns that sentence into a toast. */
  async undo(actionId: string): Promise<void> {
    this.undoing = actionId;
    try {
      await backend().conduct?.undo({ actionId });
    } finally {
      this.undoing = null;
      await this.load();
    }
  }
}

export const orchestratorActions = new OrchestratorActions();
