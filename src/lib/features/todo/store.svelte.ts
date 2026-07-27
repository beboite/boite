import { backend } from "$lib/backend";
import { notifications } from "$lib/features/notifications/store.svelte";
import { uuid } from "$lib/shared/utils/uuid";
import { t } from "$lib/i18n/index.svelte";
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

  /**
   * Desktop only. An agent writes the table straight through the loopback
   * endpoint, so the change arrives as a Rust event rather than through any
   * call this store made. Lives above the panel because the write can land
   * while the panel is closed — `ensureLoaded` would then short-circuit and
   * reopening would show a stale list.
   */
  watch(): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("boite://todos-changed", () => void this.reload()))
      .then((un) => {
        if (cancelled) un();
        else stop = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
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
      notifications.error(t("todo.saveFailed"));
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
      commitSha: null,
      claimedBy: null,
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
    // What the agent reported survives every state change. It used to be
    // cleared on anything but `claimed`, which meant ticking a box and
    // unticking it destroyed the commit, the note and the badge for good — a
    // mis-click costing the only record of where the work went. The row is
    // free to stop showing it; it is not free to throw it away.
    //
    // A later claim overwrites all three, so a reopened item that gets worked
    // on again ends up describing the new work rather than the old.
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
      notifications.error(t("todo.removeFailed"));
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
    notifications.success(t("todo.cleared", { count: doomed.length }));
  }
}

export const todos = new TodoStore();
