import { backend } from "$lib/backend";
import { notifications } from "$lib/features/notifications/store.svelte";
import { uuid } from "$lib/shared/utils/uuid";
import type { TodoItem, TodoState } from "$lib/types";

/**
 * Todos are the one table an outside process also writes: an agent reaches it
 * through the MCP endpoint while the app is open. So this store never assumes
 * its copy is authoritative — it reloads on notice, and every mutation is a
 * single-row write rather than a rewrite of the list.
 */
class TodoStore {
  items = $state<TodoItem[]>([]);
  loading = $state(false);
  private loaded = false;
  private inFlight: Promise<void> | null = null;

  forProject(projectId: string | null): TodoItem[] {
    if (!projectId) return [];
    return this.items.filter((t) => t.projectId === projectId);
  }

  /** Called by the panel; safe to call repeatedly. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    // Collapse concurrent reloads: a burst of agent writes would otherwise
    // start one query per event and land them out of order.
    if (this.inFlight) return this.inFlight;
    this.loading = true;
    this.inFlight = (async () => {
      try {
        this.items = await backend().db.loadTodos();
        this.loaded = true;
      } catch (err) {
        console.error("[todo] loadTodos failed:", err);
      } finally {
        this.loading = false;
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** A workspace switch invalidates everything: the rows live in that DB. */
  reset() {
    this.items = [];
    this.loaded = false;
  }

  private async write(item: TodoItem): Promise<void> {
    try {
      await backend().db.saveTodo(item);
    } catch (err) {
      console.error("[todo] saveTodo failed:", err);
      notifications.error("Could not save the todo");
      await this.reload();
    }
  }

  async add(projectId: string, text: string): Promise<TodoItem | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const now = Date.now();
    // Append: the largest position in this project, plus one.
    const position =
      this.forProject(projectId).reduce((max, t) => Math.max(max, t.position), -1) + 1;
    const item: TodoItem = {
      id: uuid(),
      projectId,
      text: trimmed,
      state: "open",
      note: null,
      position,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(item);
    await this.write(item);
    return item;
  }

  async setState(id: string, state: TodoState): Promise<void> {
    const item = this.items.find((t) => t.id === id);
    if (!item || item.state === state) return;
    item.state = state;
    // Confirming or reopening drops the agent's claim note: it described the
    // claim, and the claim is over.
    if (state !== "claimed") item.note = null;
    item.updatedAt = Date.now();
    await this.write($state.snapshot(item));
  }

  async setText(id: string, text: string): Promise<void> {
    const item = this.items.find((t) => t.id === id);
    if (!item) return;
    const trimmed = text.trim();
    // Emptying a line is how you delete it — an item with no text is a row that
    // can be neither labelled nor handed to an agent.
    if (!trimmed) {
      await this.remove(id);
      return;
    }
    if (item.text === trimmed) return;
    item.text = trimmed;
    item.updatedAt = Date.now();
    await this.write($state.snapshot(item));
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((t) => t.id !== id);
    try {
      await backend().db.deleteTodo(id);
    } catch (err) {
      console.error("[todo] deleteTodo failed:", err);
      notifications.error("Could not remove the todo");
      await this.reload();
    }
  }

  async clearDone(projectId: string): Promise<void> {
    const doomed = this.forProject(projectId).filter((t) => t.state === "done");
    if (doomed.length === 0) return;
    const ids = new Set(doomed.map((t) => t.id));
    this.items = this.items.filter((t) => !ids.has(t.id));
    for (const t of doomed) {
      try {
        await backend().db.deleteTodo(t.id);
      } catch (err) {
        console.error("[todo] deleteTodo failed:", err);
      }
    }
    notifications.success(`Cleared ${doomed.length} done item${doomed.length === 1 ? "" : "s"}`);
  }
}

export const todos = new TodoStore();
