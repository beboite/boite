import type {
  MobileTab,
  Project,
  Thread,
  ThreadStatus,
  View,
  WorkspaceOrigin,
} from "$lib/types";
import {
  loadProjects,
  saveProject,
  deleteProject,
  setProjectArchived,
} from "$lib/storage/db";
import { settings } from "$lib/features/settings/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { isDurable, isFinished } from "$lib/domain/thread-status";
import { t } from "$lib/i18n/index.svelte";
import { platform } from "$lib/storage/platform.svelte";
import {
  loadThreads,
  saveThread,
  updateThreadTitle,
  deleteThread as dbDeleteThread,
} from "$lib/storage/db";
import { registerProjectRoots } from "$lib/storage/scope";
import {
  clearRenamed,
  isRenamed,
  markRenamed,
  pruneRenamed,
} from "$lib/features/thread/renamed";
import { noteStatusChange, resetFinished } from "$lib/features/thread/finished.svelte";
import { isGenericTitle } from "$lib/features/thread/title-filter";
import { isScratch, SCRATCH_PROJECT_ID } from "$lib/domain/project";
import { makeScratchProject } from "$lib/features/project/scratch";
import { gitStore } from "$lib/features/git/store.svelte";
import { todos } from "$lib/features/todo/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { backend, workspace, type Backend } from "$lib/backend";
import { device } from "$lib/features/settings/device.svelte";
import type { ControlEvent } from "$lib/backend/types";

// Shared so a project with no threads always yields the same reference, and
// frozen so a caller that tries to mutate an index array fails loudly here
// instead of silently corrupting the index.
const EMPTY_THREADS = Object.freeze([]) as unknown as Thread[];

class AppState {
  projects = $state<Project[]>([]);
  threads = $state<Thread[]>([]);
  activeThreadId = $state<string | null>(null);
  selectedProjectId = $state<string | null>(null);
  view = $state<View>("terminal");
  // Phone layout only: which bottom-bar page is showing. Desktop ignores it.
  mobileTab = $state<MobileTab>("terminal");
  ready = $state(false);
  respawnNonce = $state<Record<string, number>>({});
  freshThreadIds = new Set<string>();
  // Threads whose sessionId was nulled by legacy dedup. Reactive array so
  // sidebar can show a red status dot on each until the binding is restored
  // (via /resume in the AI CLI -> session monitor's steal logic).
  unboundByDedup = $state<string[]>([]);
  // Terminals mount lazily (the page only mounts a thread the user has
  // visited), and mounting is what spawns the PTY. Anything outside the page
  // that needs a thread running again — the post-update resume — queues its id
  // here instead of reaching into the page's local state.
  requestedActivations = $state<string[]>([]);

  // Unsubscribe from the remote control plane; set while a remote workspace is
  // active so a switch can tear the subscription down.
  #unsubscribeControl: (() => void) | null = null;

  constructor() {
    // Path-scoped façades (git/explorer/editor/session) route through this in
    // dynamic mode: a path under a remote project's cwd goes to the boite.
    workspace.pathOriginResolver = (path) => this.originForPath(path);
  }

  // Longest-prefix match against project cwds. Local Windows paths and remote
  // Linux paths never collide; equal-length ties are irrelevant in practice.
  originForPath(path: string): WorkspaceOrigin {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const target = norm(path);
    let best: Project | null = null;
    for (const p of this.projects) {
      const cwd = norm(p.cwd);
      if (target === cwd || target.startsWith(cwd.endsWith("/") ? cwd : cwd + "/")) {
        if (!best || cwd.length > norm(best.cwd).length) best = p;
      }
    }
    return best?.origin ?? "local";
  }

  markUnbound(id: string) {
    if (!this.unboundByDedup.includes(id)) {
      this.unboundByDedup = [...this.unboundByDedup, id];
    }
  }

  clearUnbound(id: string) {
    if (this.unboundByDedup.includes(id)) {
      this.unboundByDedup = this.unboundByDedup.filter((x) => x !== id);
    }
  }

  // Title bursts (OSC during agent streaming) would write SQLite per token.
  // Fixed-window coalescing (not a trailing debounce — continuous bursts
  // would starve a trailing debounce forever), and only the title column is
  // written so a delayed flush can't clobber concurrent row updates.
  private pendingTitleSaves = new Map<string, string | null>();
  private titleFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleTitleFlush() {
    if (this.titleFlushTimer !== null) return;
    this.titleFlushTimer = setTimeout(() => {
      this.titleFlushTimer = null;
      const batch = [...this.pendingTitleSaves];
      this.pendingTitleSaves.clear();
      for (const [id, title] of batch) {
        const origin = this.threadById(id)?.origin;
        void updateThreadTitle(id, title, origin).catch((err) => {
          logger.error("app", "updateThreadTitle failed", err);
        });
      }
    }, 500);
  }

  // Force the debounced title batch out now. Called before anything that ends
  // the process on purpose (applying an update): the 500ms window is otherwise
  // long enough to lose the last title of every thread.
  async flushPendingWrites(): Promise<void> {
    if (this.titleFlushTimer !== null) {
      clearTimeout(this.titleFlushTimer);
      this.titleFlushTimer = null;
    }
    const batch = [...this.pendingTitleSaves];
    this.pendingTitleSaves.clear();
    await Promise.all(
      batch.map(([id, title]) => {
        const origin = this.threadById(id)?.origin;
        return updateThreadTitle(id, title, origin).catch((err) => {
          logger.error("app", "updateThreadTitle failed", err);
        });
      }),
    );
  }

  requestActivation(threadId: string) {
    if (this.requestedActivations.includes(threadId)) return;
    this.requestedActivations = [...this.requestedActivations, threadId];
  }

  clearRequestedActivations() {
    if (this.requestedActivations.length > 0) this.requestedActivations = [];
  }

  // One key, not a new record: the record is a $state proxy, so writing the key
  // is already reactive, and replacing the whole object woke every mounted
  // terminal's relaunch effect on every single reload.
  bumpRespawn(threadId: string) {
    this.respawnNonce[threadId] = (this.respawnNonce[threadId] ?? 0) + 1;
  }

  markFresh(threadId: string) {
    this.freshThreadIds.add(threadId);
  }

  consumeFresh(threadId: string): boolean {
    if (this.freshThreadIds.has(threadId)) {
      this.freshThreadIds.delete(threadId);
      return true;
    }
    return false;
  }

  // One line to hand the agent the moment its next PTY starts, as the CLI's own
  // initial prompt. A moved thread uses it to say where it landed and what was
  // left behind; a spawned one to say what it is for. In-memory and consumed on
  // read: it describes one launch, and replaying it on a later relaunch would
  // re-brief an agent about a move it already knows about.
  #pendingPrompts = new Map<string, string>();

  setPendingPrompt(threadId: string, prompt: string) {
    const text = prompt.trim();
    if (text) this.#pendingPrompts.set(threadId, text);
  }

  consumePendingPrompt(threadId: string): string | null {
    const prompt = this.#pendingPrompts.get(threadId) ?? null;
    this.#pendingPrompts.delete(threadId);
    return prompt;
  }

  // Rebuilt only when the thread set changes, never on a status or title
  // mutation: the callback reads id/projectId/createdAt and nothing else, so
  // the twice-a-second status sweep does not invalidate any of it.
  #threadById: Map<string, Thread> = $derived.by(
    () => new Map(this.threads.map((t) => [t.id, t])),
  );

  #projectById: Map<string, Project> = $derived.by(
    () => new Map(this.projects.map((p) => [p.id, p])),
  );

  #threadsByProject: Map<string, Thread[]> = $derived.by(() => {
    const grouped = new Map<string, Thread[]>();
    for (const t of this.threads) {
      const list = grouped.get(t.projectId);
      if (list) list.push(t);
      else grouped.set(t.projectId, [t]);
    }
    return grouped;
  });

  #threadsByProjectSortedIndex: Map<string, Thread[]> = $derived.by(() => {
    const orderByProject = settings.state.threadOrderByProject ?? {};
    const sorted = new Map<string, Thread[]>();
    for (const [projectId, list] of this.#threadsByProject) {
      const order = orderByProject[projectId] ?? [];
      const idx = new Map(order.map((id, i) => [id, i]));
      sorted.set(
        projectId,
        [...list].sort((a, b) => {
          const ai = idx.get(a.id) ?? Number.MAX_SAFE_INTEGER;
          const bi = idx.get(b.id) ?? Number.MAX_SAFE_INTEGER;
          if (ai !== bi) return ai - bi;
          return a.createdAt - b.createdAt;
        }),
      );
    }
    return sorted;
  });

  // Ids the index did not know about while `threads` did. Bounded, because it
  // grows on a failure that repeats: without a cap a stuck index would add one
  // entry per lookup, forever.
  #indexMisses = new Set<string>();

  /**
   * Says so when the index disagrees with the list it is built from.
   *
   * Once per id: the status engine asks about every thread twice a second, and
   * a miss that survives would otherwise write a line at that rate.
   */
  private noteIndexMiss(id: string) {
    if (this.#indexMisses.has(id)) return;
    if (this.#indexMisses.size > 200) this.#indexMisses.clear();
    this.#indexMisses.add(id);
    logger.warn("app", `${id}: the thread index missed a row the list holds`, {
      threads: this.threads.length,
      indexed: this.#threadById.size,
    });
  }

  /**
   * Every lookup used to be a linear scan, and the status engine does one per
   * thread twice a second — quadratic in the number of open threads.
   *
   * Falls back to that scan when the index misses, because the index is a
   * `$derived` and everything here treats a null as "this thread does not
   * exist". An index one beat behind the list therefore did not slow anything
   * down, it made the app deny threads that were right there: the pane stayed
   * empty (activation is gated on `hasThread`), closing refused (`closeThread`
   * returns early on a null), and only a restart — which rebuilds the index —
   * gave them back. The scan costs a pass over the list on a miss, and a miss
   * is either that bug or an id that is genuinely gone.
   */
  threadById(id: string | null | undefined): Thread | null {
    if (!id) return null;
    const hit = this.#threadById.get(id);
    if (hit) return hit;
    const scanned = this.threads.find((t) => t.id === id) ?? null;
    if (scanned) this.noteIndexMiss(id);
    return scanned;
  }

  hasThread(id: string): boolean {
    return this.threadById(id) !== null;
  }

  /** Indexed for the same reason as `threadById`: the status sweep resolves a
   * thread's directory through its project, twice a second, for every thread. */
  projectById(id: string | null | undefined): Project | null {
    if (!id) return null;
    return this.#projectById.get(id) ?? null;
  }

  get activeThread(): Thread | null {
    return this.threadById(this.activeThreadId);
  }

  /**
   * The project a launch would land in, or null when the user is on none.
   *
   * No fallback to the first row: "on no project" has to be a state the user
   * can actually be in, because that is what sends a shortcut to Scratch. Boot
   * picks the first project once (see `init`), so the empty state is only ever
   * reached by clicking the sidebar's empty space or by having no projects.
   */
  get currentProjectId(): string | null {
    if (this.selectedProjectId) return this.selectedProjectId;
    return this.activeThread?.projectId ?? null;
  }

  /** Leaves the user on no project, which is what aims a launch at Scratch. */
  clearSelection() {
    this.selectedProjectId = null;
    this.activeThreadId = null;
  }

  // Both of these return the index's own arrays. Callers iterate and map, they
  // never mutate — a fresh copy per call would defeat the reference equality
  // consumers rely on to skip work.
  threadsByProject(projectId: string): Thread[] {
    return this.#threadsByProject.get(projectId) ?? EMPTY_THREADS;
  }

  threadsByProjectSorted(projectId: string): Thread[] {
    return this.#threadsByProjectSortedIndex.get(projectId) ?? EMPTY_THREADS;
  }

  // $derived (not getters): several components read these per render pass;
  // getters would rebuild the Map + sort on every access.
  sortedProjects: Project[] = $derived.by(() => {
    const order = settings.state.projectOrder ?? [];
    const idx = new Map(order.map((id, i) => [id, i]));
    return this.projects
      .filter((p) => !p.archived)
      // An empty Scratch is not a project the user has, it is a door they have
      // not walked through. It comes back the moment a thread lands in it.
      .filter((p) => !isScratch(p) || this.threadsByProject(p.id).length > 0)
      .sort((a, b) => {
        // Scratch sits last whatever the manual order says. It is where work
        // starts, not one of the things being worked on, and drifting into the
        // middle of the real projects is the one place it does not belong.
        const as = a.id === SCRATCH_PROJECT_ID ? 1 : 0;
        const bs = b.id === SCRATCH_PROJECT_ID ? 1 : 0;
        if (as !== bs) return as - bs;
        const ai = idx.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bi = idx.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
  });

  archivedProjects: Project[] = $derived.by(() => {
    return this.projects
      .filter((p) => p.archived)
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  async init() {
    if (this.ready) return;

    // Rows depend on neither the settings blob nor the shell list, so all of
    // it goes out at once: boot is then two round trips deep (loads, then
    // syncRoots) instead of three.
    const rowsReady = this.loadRows();
    await Promise.all([settings.init(), platform.init()]);

    if (settings.state.defaultShellId === null && platform.shells.length > 0) {
      const preferred = platform.isWindows
        ? ["pwsh", "powershell", "git-bash", "cmd"]
        : ["zsh", "bash", "fish", "sh"];
      const pick =
        preferred
          .map((id) => platform.shells.find((s) => s.id === id))
          .find((s) => s != null) ?? platform.shells[0];
      if (pick) await settings.setDefaultShellIdQuiet(pick.id);
    }

    // Kick the function/alias probe now, while the rest of boot is still
    // running: by the time a shortcut is clicked the answer is already there,
    // and a shortcut clicked sooner than that costs nothing, it just falls
    // back to the PATH for that one spawn. A failure here is not worth a toast.
    if (settings.state.defaultShellId) {
      void backend()
        .shell.warmShell(settings.state.defaultShellId)
        .catch(() => {});
    }

    const { projects, threads } = await rowsReady;
    this.projects = projects;
    // The one place the selection is decided for the user: landing on nothing
    // with projects in the sidebar would send every shortcut to Scratch, which
    // is not what a user with projects means by launching one.
    this.selectedProjectId ??= this.sortedProjects[0]?.id ?? null;
    // Before ready: panels start polling fs/git commands as soon as they
    // mount, and those commands reject paths outside registered roots.
    await this.syncRoots();
    this.threads = threads;

    this.deduplicateSessionIds();
    this.dropGenericTitles();
    pruneRenamed(this.threads.map((t) => t.id));
    await this.migrateWorktrees();

    // Remote: the server is authoritative for thread runtime state and pushes
    // it as control events. Local has no subscribe and derives status itself.
    // Dynamic subscribes on the boite connection (current() is local there).
    const be = workspace.isDynamic ? workspace.remoteBackend : backend();
    if (be?.subscribe) {
      this.#unsubscribeControl = be.subscribe((ev) => this.applyControlEvent(ev));
    }

    this.ready = true;
  }

  /**
   * Drops titles a past version let through and this one would refuse.
   *
   * The filter runs when a title arrives, so a name it did not know about yet — `fastpick`
   * announcing its own image path before the agent it launches gets to speak — was written
   * to the row and outlives the fix: the thread is idle, no new title is coming, and the
   * sidebar keeps showing an executable path until someone renames it by hand. Widening the
   * set has to reach the rows already wearing the old answer.
   *
   * A name the user typed is left alone, and so is a remote row: the server owns those
   * titles and re-pushes them, so writing here would be undone anyway.
   */
  private dropGenericTitles() {
    for (const thread of this.threads) {
      if (!thread.title || isRenamed(thread.id)) continue;
      if (!isGenericTitle(thread.title)) continue;
      thread.title = null;
      if (!workspace.backendFor(thread.origin).caps.clientStatus) continue;
      void updateThreadTitle(thread.id, null, thread.origin).catch((err) => {
        logger.warn("app", `could not clear generic title for ${thread.id}`, String(err));
      });
    }
  }

  // Projects and threads are independent tables; load both concurrently.
  // Dynamic mode loads local + boite side by side and tags each row with its
  // origin; a remote failure degrades to local-only instead of blocking boot.
  private async loadRows(): Promise<{ projects: Project[]; threads: Thread[] }> {
    if (workspace.isDynamic) {
      const [projects, threads] = await Promise.all([
        this.loadDynamic((be) => be.db.loadProjects(), "loadProjects"),
        this.loadDynamic((be) => be.db.loadThreads(), "loadThreads"),
      ]);
      return { projects, threads };
    }
    const [projects, threads] = await Promise.all([
      loadProjects().catch((err) => {
        logger.error("app", "loadProjects failed", err);
        return [] as Project[];
      }),
      loadThreads().catch((err) => {
        logger.error("app", "loadThreads failed", err);
        return [] as Thread[];
      }),
    ]);
    return { projects, threads };
  }

  // Load one table from both live backends and tag each row's origin.
  private async loadDynamic<T extends { origin?: WorkspaceOrigin }>(
    load: (be: Backend) => Promise<T[]>,
    label: string,
  ): Promise<T[]> {
    const localP = load(workspace.backendFor("local")).catch((err) => {
      logger.error("app", `${label} (local) failed`, err);
      return [] as T[];
    });
    const remote = workspace.remoteBackend;
    const remoteP = remote
      ? load(remote).catch((err) => {
          logger.error("app", `${label} (remote) failed`, err);
          return [] as T[];
        })
      : Promise.resolve([] as T[]);
    const [localRows, remoteRows] = await Promise.all([localP, remoteP]);
    return [
      ...localRows.map((r) => ({ ...r, origin: "local" as const })),
      ...remoteRows.map((r) => ({ ...r, origin: "remote" as const })),
    ];
  }

  // Clear reactive state so a workspace switch re-hydrates from the new
  // backend instead of mixing two workspaces' projects/threads.
  reset() {
    this.#unsubscribeControl?.();
    this.#unsubscribeControl = null;
    if (this.titleFlushTimer !== null) {
      clearTimeout(this.titleFlushTimer);
      this.titleFlushTimer = null;
    }
    this.pendingTitleSaves.clear();
    this.freshThreadIds.clear();
    resetFinished();
    this.projects = [];
    this.threads = [];
    this.activeThreadId = null;
    this.selectedProjectId = null;
    this.view = "terminal";
    this.mobileTab = "terminal";
    this.respawnNonce = {};
    this.unboundByDedup = [];
    this.requestedActivations = [];
    this.ready = false;
  }

  // Apply a server-pushed control event (remote only). The server owns thread
  // runtime state; the client projects it.
  private applyControlEvent(ev: ControlEvent) {
    const data = ev.data as Record<string, unknown> | null;
    switch (ev.event) {
      case "thread.status": {
        const id = data?.threadId as string | undefined;
        const t = this.threadById(id);
        if (!t) return;
        const incomingStatus = (data?.status as Thread["status"]) ?? t.status;
        // The remote path writes the row directly rather than going through
        // setThreadStatus (the server owns runtime state, so none of that
        // method's persistence applies), which means the finish mark has to be
        // laid here too or a boite's threads would never glow.
        noteStatusChange(t.id, t.status, incomingStatus);
        t.status = incomingStatus;
        t.exitCode = (data?.exitCode as number | null) ?? null;
        // Four statuses, not three. `stopped` used to be missing here and
        // nowhere else, so a thread the server had put to sleep kept a ptyId
        // pointing at a process it had already reaped — and `visibleStatus`
        // then drew it as ready. `stopThread` clears the id on the local path
        // for the same reason.
        if (isFinished(t.status)) {
          t.ptyId = null;
        }
        break;
      }
      case "thread.title": {
        const id = data?.threadId as string | undefined;
        const t = this.threadById(id);
        // A user-typed name outranks whatever the server parsed out of the PTY.
        if (t && !isRenamed(t.id)) t.title = (data?.title as string) ?? t.title;
        break;
      }
      case "thread.created": {
        // Server emits data = { thread: {...} }.
        const incoming = (ev.data as { thread?: Thread })?.thread;
        if (incoming?.id && !this.hasThread(incoming.id)) {
          if (workspace.isDynamic) incoming.origin = "remote";
          this.threads.push(incoming);
        }
        break;
      }
      case "thread.updated": {
        // data = { thread: {...} }. Merge user-owned fields only; runtime
        // fields (status/ptyId/exitCode) are driven by thread.status and the
        // live overlay, never clobbered by an update.
        const incoming = (ev.data as { thread?: Partial<Thread> & { id?: string } })?.thread;
        const id = incoming?.id;
        const t = this.threadById(id);
        if (t && incoming) {
          const userFields: Record<string, unknown> = { ...incoming };
          delete userFields.status;
          delete userFields.ptyId;
          delete userFields.exitCode;
          delete userFields.origin;
          if (isRenamed(t.id)) delete userFields.title;
          Object.assign(t, userFields);
        }
        break;
      }
      case "thread.deleted": {
        const id = data?.threadId as string | undefined;
        if (id) this.threads = this.threads.filter((x) => x.id !== id);
        break;
      }
      case "project.changed": {
        void this.refreshRemoteProjects().catch(() => {});
        break;
      }
      // The writer may be an agent on the server rather than a client, so the
      // event carries no row — reload instead of patching one in.
      case "todos.changed": {
        void todos.reload().catch(() => {});
        break;
      }
      // Another device renamed/recolored this boite. Cosmetic; update the
      // live identity and the cached label on the device registry.
      case "workspace.info": {
        const name = typeof data?.name === "string" ? data.name : null;
        const color = typeof data?.color === "string" ? data.color : null;
        workspace.info = { name, color };
        if (workspace.activeBoiteId) {
          device.updateBoite(workspace.activeBoiteId, {
            name: name ?? "",
            color: color ?? "",
          });
        }
        break;
      }
      // An agent on the boite asked to be moved, or for a project, or for a
      // second terminal. It reaches every connected device because the server
      // cannot tell which one is watching; the handler claims it first so only
      // one device acts. Imported late: the handler pulls in the thread and
      // project APIs, which import this store.
      case "agent.request": {
        void import("./agent-requests")
          .then((m) => m.handleRemoteAgentRequest(ev.data))
          .catch((err) => logger.error("app", "agent.request failed", err));
        break;
      }
      // The server lost track of which control events we missed (broadcast
      // lag); refetch the durable lists so we don't diverge silently.
      case "resync": {
        void this.resyncFromServer();
        break;
      }
    }
  }

  // Control events only concern the boite: in dynamic mode refresh the remote
  // subset and leave local rows (and their live runtime state) untouched.
  private async refreshRemoteProjects() {
    if (workspace.isDynamic) {
      const remote = workspace.remoteBackend;
      if (!remote) return;
      const p = await remote.db.loadProjects();
      this.projects = [
        ...this.projects.filter((x) => x.origin !== "remote"),
        ...p.map((x) => ({ ...x, origin: "remote" as const })),
      ];
    } else {
      this.projects = await loadProjects();
    }
  }

  private async resyncFromServer() {
    try {
      if (workspace.isDynamic) {
        const remote = workspace.remoteBackend;
        if (!remote) return;
        const [projects, threads] = await Promise.all([
          remote.db.loadProjects(),
          remote.db.loadThreads(),
        ]);
        this.projects = [
          ...this.projects.filter((x) => x.origin !== "remote"),
          ...projects.map((x) => ({ ...x, origin: "remote" as const })),
        ];
        this.threads = [
          ...this.threads.filter((x) => x.origin !== "remote"),
          ...threads.map((x) => ({ ...x, origin: "remote" as const })),
        ];
      } else {
        const [projects, threads] = await Promise.all([loadProjects(), loadThreads()]);
        this.projects = projects;
        this.threads = threads;
      }
    } catch (err) {
      logger.error("app", "resync failed", err);
    }
  }

  // Legacy fix: pre-0.5.5 builds could let multiple threads capture the
  // same session id. We can't know which thread was the "real" owner, so
  // when a collision is detected we null EVERY conflicting thread. Each one
  // respawns fresh on next wake; user rebinds via /resume in the AI CLI.
  private deduplicateSessionIds() {
    // Remote owns session bindings: this legacy local fix would write back via
    // thread.create (clobbering server-owned state) and toast about /resume,
    // which is meaningless remotely. Only threads whose backend derives status
    // client-side (local) are considered — in dynamic mode the boite's threads
    // are excluded, in pure remote mode that's every thread.
    const sniffable = this.threads.filter(
      (t) => workspace.backendFor(t.origin).caps.clientStatus,
    );
    if (sniffable.length === 0) return;
    const withSession = sniffable.filter((t) => t.sessionId);
    console.info(
      `[boite] session dedup: ${sniffable.length} threads loaded, ${withSession.length} with sessionId`,
    );
    const bySession = new Map<string, Thread[]>();
    for (const t of withSession) {
      const list = bySession.get(t.sessionId as string) ?? [];
      list.push(t);
      bySession.set(t.sessionId as string, list);
    }
    let cleared = 0;
    for (const [sid, threads] of bySession) {
      if (threads.length < 2) continue;
      const labels = threads.map((t) => t.label).join(", ");
      logger.warn(
        "app",
        `sessionId ${sid} shared by ${threads.length} threads (${labels}); clearing all to break cross-talk`,
      );
      for (const t of threads) {
        t.sessionId = null;
        this.markUnbound(t.id);
        cleared++;
        void saveThread($state.snapshot(t) as Thread);
      }
    }
    if (cleared > 0) {
      logger.warn(
        "app",
        `cleared ${cleared} legacy thread session bindings; each needs /resume to rebind`,
      );
      notifications.error(t("app.clearedSessionBindings", { count: cleared }), 8000);
    }
  }

  /**
   * Brings worktrees left outside their project back into it.
   *
   * Placed between the thread rows landing and `ready`: a terminal only mounts
   * once the page is past its loading state, and mounting is what spawns the
   * PTY, so nothing is holding a directory this moves. It also has to follow
   * `syncRoots`, since the backend refuses a repository it has no root for.
   *
   * One thread at a time. Two `git worktree move` in the same repository fight
   * over its lock, and threads of one project are the common case.
   */
  private async migrateWorktrees() {
    let adopted = 0;
    for (const t of this.threads) {
      const project = this.projects.find((p) => p.id === t.projectId);
      if (!project) continue;
      if (!t.worktreePath) {
        // A thread with no path may still own a checkout: the `gone` branch
        // below clears the row on one unreadable answer, and the directory it
        // forgot is still there. Left forgotten, the thread runs in the user's
        // own project folder while claiming isolation, and `--resume` looks for
        // its transcript under a directory the agent never ran in — which is
        // "No conversation found with session ID" for a session that exists.
        //
        // Only worth asking for a thread that could have had one. A blank
        // terminal and a scratch thread never do, and asking is a filesystem
        // walk per thread at every boot.
        if (t.iconKey === "terminal" || isScratch(project)) continue;
        try {
          const found = await workspace
            .backendFor(t.origin)
            .worktree.adopt(project.gitRoot ?? project.cwd, t.id);
          if (!found) continue;
          t.worktreePath = found;
          await saveThread($state.snapshot(t) as Thread);
          adopted++;
          logger.info("worktree", `adopted ${found} back for ${t.id}`);
        } catch (err) {
          // Nothing is lost by not answering: the thread keeps running in the
          // project folder, exactly as it did before this existed.
          logger.warn("worktree", `could not look for a worktree for ${t.id}`, String(err));
        }
        continue;
      }
      try {
        const answer = await workspace
          .backendFor(t.origin)
          .worktree.migrate(project.gitRoot ?? project.cwd, t.id, t.worktreePath);
        // A directory that is not there any more. Kept, the thread spawned its
        // PTY in it and the launch failed on a path nobody could see, every
        // start, forever. Forgotten, the thread runs in the project folder,
        // which is what a thread with no worktree has always done.
        if (answer.gone) {
          logger.info("worktree", `forgot ${t.worktreePath} for ${t.id}`, "it is gone");
          t.worktreePath = null;
          await saveThread($state.snapshot(t) as Thread);
          continue;
        }
        // No path is the answer for every worktree already in its project,
        // which after the first launch is all of them.
        if (!answer.path) continue;
        t.worktreePath = answer.path;
        await saveThread($state.snapshot(t) as Thread);
      } catch (err) {
        // One that will not move keeps the path it has, and the thread starts
        // in it exactly as it did before. Never a reason to hold up boot.
        logger.warn("worktree", `kept ${t.worktreePath} for ${t.id}`, String(err));
      }
    }
    if (adopted > 0) {
      notifications.success(t("worktree.adoptedBack", { count: adopted }));
    }
  }

  /**
   * Puts the thread in the store now, and persists it behind the caller.
   *
   * Not async on purpose: the store write has to happen at call time, in the
   * click's own task, while the returned promise is only the row reaching
   * SQLite. A launch does not await it — the sidebar entry and the terminal are
   * what the user clicked for, and an IPC round trip plus a WAL commit in front
   * of them is a wait for nothing. A caller that has to know the row landed
   * (a move, which reports failure and gives up) still awaits.
   *
   * Rejects rather than swallowing: callers show a "Failed to create thread"
   * toast. Swallowing here left the thread memory-only, silently vanishing on
   * restart.
   */
  upsertThread(thread: Thread): Promise<void> {
    const i = this.threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) this.threads[i] = thread;
    else this.threads.push(thread);
    return saveThread(thread);
  }

  async removeThread(id: string) {
    const removed = this.threadById(id);
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) {
      const projectId = removed?.projectId ?? this.selectedProjectId;
      this.selectedProjectId = projectId ?? this.selectedProjectId;
      this.activeThreadId = null;
    }
    clearRenamed(id);
    try {
      await dbDeleteThread(id, removed?.origin);
    } catch (err) {
      logger.error("app", "deleteThread failed", err);
      notifications.error(t("app.closeThreadFailed"));
    }
  }

  setThreadStatus(id: string, status: ThreadStatus, exitCode: number | null = null) {
    const t = this.threadById(id);
    if (!t) return;
    if (t.status === status && t.exitCode === exitCode) return;
    noteStatusChange(id, t.status, status);
    t.status = status;
    t.exitCode = exitCode;
    if (status !== "stopped" && t.autoSlept) {
      // Drop the sleep badge as soon as the thread leaves "stopped". The flag
      // is in-memory only (see setThreadAutoSlept), so this clear — not any
      // write — is the whole reason a woken thread stops animating.
      this.setThreadAutoSlept(id, false);
    }
    // Remote: the server persists runtime state and pushes it back; a client
    // write would clobber it. Only the local backend persists status here.
    if (!workspace.backendFor(t.origin).caps.clientStatus) return;
    if (isDurable(status)) {
      void saveThread($state.snapshot(t) as Thread);
    }
  }

  setThreadAutoSlept(id: string, value: boolean) {
    const t = this.threadById(id);
    if (!t || (t.autoSlept ?? false) === value) return;
    t.autoSlept = value;
    // Visual-only flag, never persisted. After a restart all threads come
    // back without the zZ animation; clicking re-spawns them like any
    // other stopped thread.
  }

  setThreadKeepAwake(id: string, value: boolean) {
    const t = this.threadById(id);
    if (!t || (t.keepAwake ?? false) === value) return;
    t.keepAwake = value;
    void saveThread($state.snapshot(t) as Thread);
  }

  toggleThreadKeepAwake(id: string) {
    const t = this.threadById(id);
    if (!t) return;
    this.setThreadKeepAwake(id, !(t.keepAwake ?? false));
  }

  setThreadTitle(id: string, title: string) {
    // Named by hand: the agent's own titles stop applying to this thread.
    if (isRenamed(id)) return;
    const t = this.threadById(id);
    if (!t || t.title === title) return;
    t.title = title;
    // Remote owns the title (parsed server-side, pushed as a control event).
    if (!workspace.backendFor(t.origin).caps.clientStatus) return;
    this.pendingTitleSaves.set(id, title);
    this.scheduleTitleFlush();
  }

  // Manual rename. Unlike setThreadTitle this persists on every backend: the
  // remote server only writes back titles it parsed itself, so a name typed
  // here would never reach its row. Passing null drops the manual name — the
  // thread falls back to its label and the agent gets to title it again.
  async renameThread(id: string, name: string | null) {
    // Named `thread`, not `t`: this file uses `t` for a thread almost everywhere,
    // and here that shadows the translation helper.
    const thread = this.threadById(id);
    if (!thread) return;
    const title = name?.trim() || null;
    thread.title = title;
    // An OSC title queued just before the rename would land on top of it.
    this.pendingTitleSaves.delete(id);
    if (title) markRenamed(id);
    else clearRenamed(id);
    try {
      await updateThreadTitle(id, title, thread.origin);
    } catch (err) {
      logger.error("app", "renameThread failed", err);
      notifications.error(t("app.renameThreadFailed"));
    }
  }

  setThreadPtyId(id: string, ptyId: string | null) {
    const t = this.threadById(id);
    if (!t || t.ptyId === ptyId) return;
    t.ptyId = ptyId;
  }

  private async syncRoots() {
    try {
      // Tauri's fs trust boundary only concerns local paths; the server derives
      // its own from persisted projects. In dynamic mode remote cwds are Linux
      // paths that must not pollute the local scope.
      const roots = this.projects
        .filter((p) => (p.origin ?? "local") === "local")
        .map((p) => p.cwd);
      await registerProjectRoots(roots);
    } catch (err) {
      logger.error("app", "registerProjectRoots failed", err);
    }
  }

  async updateProject(project: Project) {
    const idx = this.projects.findIndex((p) => p.id === project.id);
    if (idx !== -1) this.projects[idx] = project;
    try {
      await saveProject(project);
    } catch (err) {
      logger.error("app", "saveProject failed", err);
      notifications.error(t("app.saveProjectFailed"));
    }
  }

  // The name is only a label: it starts out as whatever inspect() guessed from
  // the folder, and nothing downstream keys off it, so a rename is a plain
  // column write. cwd stays put — the folder on disk is untouched.
  async renameProject(id: string, name: string) {
    const p = this.projects.find((x) => x.id === id);
    const next = name.trim();
    if (!p || !next || p.name === next) return;
    p.name = next;
    try {
      await saveProject($state.snapshot(p) as Project);
    } catch (err) {
      logger.error("app", "renameProject failed", err);
      notifications.error(t("app.renameProjectFailed"));
    }
  }

  /**
   * Whether this project's agent threads get their own worktree.
   *
   * Writes an explicit boolean rather than clearing back to null: once the user
   * has said, moving the app-wide default must not silently move this project
   * with it. Only threads started after this see it — a thread's directory is
   * decided when it is born and never again.
   */
  async setProjectWorktrees(id: string, enabled: boolean) {
    const p = this.projects.find((x) => x.id === id);
    if (!p || (p.worktrees ?? null) === enabled) return;
    p.worktrees = enabled;
    try {
      await saveProject($state.snapshot(p) as Project);
    } catch (err) {
      logger.error("app", "setProjectWorktrees failed", err);
      notifications.error(t("app.worktreeSettingFailed"));
    }
  }

  /**
   * The Scratch row, made and persisted if this workspace has none.
   *
   * Lazy on purpose: the sidebar hides it while it is empty, so seeding it at
   * boot would only have written a row nobody could see. Unarchived on the way
   * out — launching into a project the user has put away has to put it back,
   * or the thread lands somewhere the sidebar refuses to show.
   */
  async ensureScratch(): Promise<Project | null> {
    const already = this.projects.find((p) => p.id === SCRATCH_PROJECT_ID);
    if (already) {
      if (already.archived) await this.unarchiveProject(already.id);
      return already;
    }
    const scratch = await makeScratchProject(
      workspace.isDynamic ? "local" : undefined,
    );
    if (!scratch) {
      notifications.error(t("app.noHomeFolder"));
      return null;
    }
    await this.addProject(scratch);
    return scratch;
  }

  async addProject(project: Project) {
    this.projects.push(project);
    await this.syncRoots();
    try {
      await saveProject(project);
    } catch (err) {
      logger.error("app", "saveProject failed", err);
      notifications.error(t("app.saveProjectFailed"));
    }
  }

  async archiveProject(id: string) {
    const p = this.projects.find((x) => x.id === id);
    if (!p || p.archived) return;
    p.archived = true;
    if (this.selectedProjectId === id) {
      this.selectedProjectId = this.sortedProjects[0]?.id ?? null;
    }
    if (this.activeThread?.projectId === id) {
      this.activeThreadId = null;
    }
    try {
      await setProjectArchived(id, true, p.origin);
    } catch (err) {
      logger.error("app", "archiveProject failed", err);
      notifications.error(t("app.archiveFailed"));
    }
  }

  async unarchiveProject(id: string) {
    const p = this.projects.find((x) => x.id === id);
    if (!p || !p.archived) return;
    p.archived = false;
    try {
      await setProjectArchived(id, false, p.origin);
    } catch (err) {
      logger.error("app", "unarchiveProject failed", err);
      notifications.error(t("app.unarchiveFailed"));
    }
  }

  async removeProject(id: string) {
    const removed = this.projects.find((p) => p.id === id);
    const orphanThreads = this.threads.filter((t) => t.projectId === id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.threads = this.threads.filter((t) => t.projectId !== id);
    // A selection pointing at a row that is gone is a project id nothing can
    // resolve, and every launch would refuse until the user clicked elsewhere.
    if (this.selectedProjectId === id) {
      this.selectedProjectId = this.sortedProjects[0]?.id ?? null;
    }
    gitStore.drop(id);
    void this.syncRoots();
    for (const t of orphanThreads) {
      try {
        await dbDeleteThread(t.id, t.origin);
      } catch {
        // ignore
      }
    }
    try {
      await deleteProject(id, removed?.origin);
    } catch (err) {
      logger.error("app", "deleteProject failed", err);
      notifications.error(t("app.removeProjectFailed"));
    }
  }

}

export const app = new AppState();
