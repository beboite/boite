import { app } from "$lib/app/store.svelte";
import { backend, backendFor, workspace } from "$lib/backend";
import { notifications } from "$lib/features/notifications/store.svelte";
import { uuid } from "$lib/shared/utils/uuid";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import type { TodoItem, TodoState } from "$lib/types";
import { diffTodos } from "./diff";
import { todoAnnouncer } from "./announce.svelte";

/**
 * Which host holds a project's todos.
 *
 * The row does not say: a todo names a project, a project names a machine, and
 * that is the whole chain. Every call here went through `backend()` instead,
 * which is the local desktop in dynamic mode whatever the card belonged to, so
 * a todo written on a boite project's panel landed in the local SQLite where
 * the agent it was written for could never see it.
 */
function hostOf(projectId: string) {
  return backendFor(app.projectById(projectId)?.origin);
}

/** What a failed load says, as the panel prints it. */
function reason(err: unknown): string {
  return String(err).replace(/^Error:\s*/i, "").trim() || "load failed";
}

/**
 * Todos are the one table an outside process also writes: an agent reaches it
 * through the MCP endpoint while the app is open. So this store never assumes
 * its copy is authoritative — it reloads on notice, and every mutation is a
 * single-row write rather than a rewrite of the list.
 */
class TodoStore {
  items = $state<TodoItem[]>([]);
  loading = $state(false);
  /**
   * Why the last load failed, or null. A failed load used to render exactly like
   * an empty project: the console got the reason and the panel drew "nothing to
   * do here".
   */
  loadError = $state<string | null>(null);
  private loaded = false;
  private inFlight: Promise<void> | null = null;
  /** A change landed while a query was already out; that query's answer is old. */
  private stale = false;
  /**
   * Whether the reload currently running gets to announce what it finds.
   *
   * Belongs to that one reload, not to the store. A failed write reloads
   * quietly to put the row back the way the database has it, and announcing
   * that would say an agent did something when the truth is that the user's
   * own edit did not stick — but reloads collapse, so a quiet one can end up
   * being the query an agent's write is waiting on. It is un-muted when that
   * happens: a caller joining is a caller who wants the news.
   */
  private announce = false;
  /**
   * Why one half of a two-host load came back empty, or null.
   *
   * Kept apart from the throw below because the other half still answered: the
   * panel prints this over the rows it did get, rather than instead of them.
   */
  private partial: string | null = null;

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
    return this.run(true);
  }

  private async run(announce: boolean): Promise<void> {
    // Collapse concurrent reloads: a burst of agent writes would otherwise
    // start one query per event and land them out of order. The join is not
    // free though — the running query may have read the table before the write
    // that triggered this call — so a second asker leaves a mark, and the
    // in-flight one runs again rather than answering with what it already has.
    if (this.inFlight) {
      this.stale = true;
      // The mark is not enough on its own: a quiet reload that a loud caller
      // joins would re-read the table and then swallow that caller's deltas,
      // which is an agent's write disappearing because the user's last edit
      // happened to fail.
      if (announce) this.announce = true;
      return this.inFlight;
    }
    this.loading = true;
    this.announce = announce;
    this.inFlight = (async () => {
      try {
        // The list before the outside changed it. Only a reload can see this:
        // every local mutation writes one row and never comes through here, so
        // diffing at this point announces an agent's work and stays silent
        // about the user's own clicks.
        const before = $state.snapshot(this.items) as TodoItem[];
        do {
          this.stale = false;
          this.items = await this.loadEverywhere();
        } while (this.stale);
        // Not on the first load: every row is new to an empty list, and a boot
        // with eight open todos would queue eight announcements.
        //
        // Only this project's: an agent finishing a task in a repo the user is
        // not looking at has nothing to say to them right now.
        if (this.loaded && this.announce) {
          const projectId = app.currentProjectId;
          todoAnnouncer.push(
            diffTodos(before, this.items).filter(
              (d) => d.todo.projectId === projectId,
            ),
          );
        }
        this.loaded = true;
        this.loadError = this.partial;
      } catch (err) {
        logger.error("todo", "loadTodos failed", err);
        this.loadError = reason(err);
      } finally {
        this.loading = false;
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Every open host's rows, in one list.
   *
   * Two databases in dynamic mode, merged the way boot merges projects and
   * threads (`app/hydrate.ts`). Reading the local one alone is why a boite
   * project's panel was empty whatever its agents had written, with nothing on
   * screen saying so. Nothing is tagged on the way in: a row carries its
   * project and the project carries the machine, which is also what routes the
   * writes below.
   *
   * A boite that is down costs the user the boite's rows and not the panel,
   * like the boot merge, and it says so: an empty list and an unreachable host
   * look identical on screen.
   */
  private async loadEverywhere(): Promise<TodoItem[]> {
    this.partial = null;
    if (!workspace.isDynamic) return backend().db.loadTodos();
    const remote = workspace.remoteBackend;
    const [here, boite] = await Promise.all([
      workspace.backendFor("local").db.loadTodos(),
      remote
        ? remote.db.loadTodos().catch((err) => {
            logger.error("todo", "loadTodos (remote) failed", err);
            this.partial = reason(err);
            return [] as TodoItem[];
          })
        : Promise.resolve([] as TodoItem[]),
    ]);
    return [...here, ...boite];
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

  /** Re-read without announcing. For putting the list back after a failed
      write, which is the app correcting itself rather than news. */
  private async reloadQuietly(): Promise<void> {
    await this.run(false);
  }

  /** A workspace switch invalidates everything: the rows live in that DB. */
  reset() {
    this.items = [];
    this.loaded = false;
    todoAnnouncer.reset();
  }

  private async write(item: TodoItem): Promise<void> {
    try {
      await hostOf(item.projectId).db.saveTodo(item);
    } catch (err) {
      logger.error("todo", "saveTodo failed", err);
      notifications.error(t("todo.saveFailed"));
      await this.reloadQuietly();
    }
  }

  async add(projectId: string, title: string): Promise<TodoItem | null> {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const now = Date.now();
    // Append: the largest position in this project, plus one.
    const position =
      this.forProject(projectId).reduce((max, t) => Math.max(max, t.position), -1) + 1;
    const item: TodoItem = {
      id: uuid(),
      projectId,
      title: trimmed,
      description: null,
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

  async setTitle(id: string, title: string): Promise<void> {
    const item = this.items.find((t) => t.id === id);
    if (!item) return;
    const trimmed = title.trim();
    // Emptying the title is how you delete a card — one with no title is a row
    // that can be neither labelled nor handed to an agent. Unless it has a
    // description: that is a card someone wrote a paragraph into, and clearing
    // one field is not a request to destroy the other.
    if (!trimmed) {
      if (item.description) return;
      await this.remove(id);
      return;
    }
    if (item.title === trimmed) return;
    item.title = trimmed;
    item.updatedAt = Date.now();
    await this.write($state.snapshot(item));
  }

  /** Empty and absent are the same thing here, and only null is stored. */
  async setDescription(id: string, description: string): Promise<void> {
    const item = this.items.find((t) => t.id === id);
    if (!item) return;
    const next = description.trim() || null;
    if (item.description === next) return;
    item.description = next;
    item.updatedAt = Date.now();
    await this.write($state.snapshot(item));
  }

  /**
   * Rewrites the order of one project's cards, `orderedIds` first to last.
   *
   * Positions are renumbered from zero rather than nudged around the moved row:
   * the table is appended to by agents as well, `MAX(position) + 1` is computed
   * without a lock on either side, and two rows sharing a position is a state
   * this list has to be able to leave. Renumbering is also what makes the
   * result survive the reload an agent's next write triggers.
   */
  async reorder(projectId: string, orderedIds: string[]): Promise<void> {
    const now = Date.now();
    const changed: TodoItem[] = [];
    orderedIds.forEach((id, index) => {
      const item = this.items.find((t) => t.id === id);
      if (!item || item.projectId !== projectId || item.position === index) return;
      item.position = index;
      item.updatedAt = now;
      changed.push($state.snapshot(item));
    });
    if (changed.length === 0) return;
    // `forProject` filters and does not sort, so the panel shows whatever order
    // this array is in. Same comparison the load query uses, applied to every
    // project at once because that is how the rows come back.
    this.items = [...this.items].sort(
      (a, b) => a.position - b.position || a.createdAt - b.createdAt,
    );
    await Promise.all(changed.map((item) => this.write(item)));
  }

  async remove(id: string): Promise<void> {
    // Read before the row leaves the list: its project is the only thing that
    // says which database the id belongs to, and a delete sent to the other one
    // silently removes nothing while the card is already gone from the panel.
    const doomed = this.items.find((t) => t.id === id);
    if (!doomed) return;
    this.items = this.items.filter((t) => t.id !== id);
    try {
      await hostOf(doomed.projectId).db.deleteTodo(id);
    } catch (err) {
      logger.error("todo", "deleteTodo failed", err);
      notifications.error(t("todo.removeFailed"));
      await this.reloadQuietly();
    }
  }

  async clearDone(projectId: string): Promise<void> {
    const doomed = this.forProject(projectId).filter((t) => t.state === "done");
    if (doomed.length === 0) return;
    const ids = new Set(doomed.map((t) => t.id));
    this.items = this.items.filter((t) => !ids.has(t.id));
    // One host for the lot: they are one project's rows, and a project sits on
    // one machine.
    const db = hostOf(projectId).db;
    const results = await Promise.allSettled(
      doomed.map((item) => db.deleteTodo(item.id)),
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.error("todo", "clearDone partly failed", {
        failed: failed.length,
        of: doomed.length,
      });
      // The rows are already gone from the list, so the only honest move is to
      // put back whatever the database still holds.
      notifications.error(t("todo.removeFailed"));
      await this.reload();
      return;
    }
    notifications.success(t("todo.cleared", { count: doomed.length }));
  }
}

export const todos = new TodoStore();
