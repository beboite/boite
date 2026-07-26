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
import { gitStore } from "$lib/features/git/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { backend, workspace, type Backend } from "$lib/backend";
import { device } from "$lib/features/settings/device.svelte";
import type { ControlEvent } from "$lib/backend/types";

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
        const origin = this.threads.find((x) => x.id === id)?.origin;
        void updateThreadTitle(id, title, origin).catch((err) => {
          console.error("updateThreadTitle failed:", err);
        });
      }
    }, 500);
  }

  bumpRespawn(threadId: string) {
    this.respawnNonce = {
      ...this.respawnNonce,
      [threadId]: (this.respawnNonce[threadId] ?? 0) + 1,
    };
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

  get activeThread(): Thread | null {
    return this.threads.find((t) => t.id === this.activeThreadId) ?? null;
  }

  get currentProjectId(): string | null {
    if (this.selectedProjectId) return this.selectedProjectId;
    if (this.activeThread) return this.activeThread.projectId;
    return this.projects[0]?.id ?? null;
  }

  threadsByProject(projectId: string): Thread[] {
    return this.threads.filter((t) => t.projectId === projectId);
  }

  // $derived (not getters): several components read these per render pass;
  // getters would rebuild the Map + sort on every access.
  sortedProjects: Project[] = $derived.by(() => {
    const order = settings.state.projectOrder ?? [];
    const idx = new Map(order.map((id, i) => [id, i]));
    return this.projects
      .filter((p) => !p.archived)
      .sort((a, b) => {
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

  threadsByProjectSorted(projectId: string): Thread[] {
    const list = this.threadsByProject(projectId);
    const order = settings.state.threadOrderByProject?.[projectId] ?? [];
    const idx = new Map(order.map((id, i) => [id, i]));
    return [...list].sort((a, b) => {
      const ai = idx.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = idx.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.createdAt - b.createdAt;
    });
  }

  async init() {
    if (this.ready) return;
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

    // Projects and threads are independent tables; load both concurrently.
    // Dynamic mode loads local + boite side by side and tags each row with its
    // origin; a remote failure degrades to local-only instead of blocking boot.
    if (workspace.isDynamic) {
      const [projects, threads] = await Promise.all([
        this.loadDynamic((be) => be.db.loadProjects(), "loadProjects"),
        this.loadDynamic((be) => be.db.loadThreads(), "loadThreads"),
      ]);
      this.projects = projects;
      // Before ready: panels start polling fs/git commands as soon as they
      // mount, and those commands reject paths outside registered roots.
      await this.syncRoots();
      this.threads = threads;
    } else {
      const projectsPromise = loadProjects().catch((err) => {
        console.error("loadProjects failed:", err);
        return [] as Project[];
      });
      const threadsPromise = loadThreads().catch((err) => {
        console.error("loadThreads failed:", err);
        return [] as Thread[];
      });
      this.projects = await projectsPromise;
      await this.syncRoots();
      this.threads = await threadsPromise;
    }
    this.deduplicateSessionIds();
    pruneRenamed(this.threads.map((t) => t.id));

    // Remote: the server is authoritative for thread runtime state and pushes
    // it as control events. Local has no subscribe and derives status itself.
    // Dynamic subscribes on the boite connection (current() is local there).
    const be = workspace.isDynamic ? workspace.remoteBackend : backend();
    if (be?.subscribe) {
      this.#unsubscribeControl = be.subscribe((ev) => this.applyControlEvent(ev));
    }

    this.ready = true;
  }

  // Load one table from both live backends and tag each row's origin.
  private async loadDynamic<T extends { origin?: WorkspaceOrigin }>(
    load: (be: Backend) => Promise<T[]>,
    label: string,
  ): Promise<T[]> {
    const localP = load(workspace.backendFor("local")).catch((err) => {
      console.error(`${label} (local) failed:`, err);
      return [] as T[];
    });
    const remote = workspace.remoteBackend;
    const remoteP = remote
      ? load(remote).catch((err) => {
          console.error(`${label} (remote) failed:`, err);
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
    this.projects = [];
    this.threads = [];
    this.activeThreadId = null;
    this.selectedProjectId = null;
    this.view = "terminal";
    this.mobileTab = "terminal";
    this.respawnNonce = {};
    this.unboundByDedup = [];
    this.ready = false;
  }

  // Apply a server-pushed control event (remote only). The server owns thread
  // runtime state; the client projects it.
  private applyControlEvent(ev: ControlEvent) {
    const data = ev.data as Record<string, unknown> | null;
    switch (ev.event) {
      case "thread.status": {
        const id = data?.threadId as string | undefined;
        const t = id ? this.threads.find((x) => x.id === id) : undefined;
        if (!t) return;
        t.status = (data?.status as Thread["status"]) ?? t.status;
        t.exitCode = (data?.exitCode as number | null) ?? null;
        if (t.status === "done" || t.status === "exited" || t.status === "error") {
          t.ptyId = null;
        }
        break;
      }
      case "thread.title": {
        const id = data?.threadId as string | undefined;
        const t = id ? this.threads.find((x) => x.id === id) : undefined;
        // A user-typed name outranks whatever the server parsed out of the PTY.
        if (t && !isRenamed(t.id)) t.title = (data?.title as string) ?? t.title;
        break;
      }
      case "thread.created": {
        // Server emits data = { thread: {...} }.
        const incoming = (ev.data as { thread?: Thread })?.thread;
        if (incoming?.id && !this.threads.some((x) => x.id === incoming.id)) {
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
        const t = id ? this.threads.find((x) => x.id === id) : undefined;
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
      console.error("resync failed:", err);
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
      console.warn(
        `[boite] sessionId ${sid} shared by ${threads.length} threads (${labels}); clearing all to break cross-talk`,
      );
      for (const t of threads) {
        t.sessionId = null;
        this.markUnbound(t.id);
        cleared++;
        void saveThread($state.snapshot(t) as Thread);
      }
    }
    if (cleared > 0) {
      console.warn(
        `[boite] cleared ${cleared} legacy thread session bindings. Use /resume in your AI CLI to rebind each thread to its conversation.`,
      );
      notifications.error(
        `Cleared ${cleared} colliding session bindings. Use /resume in each thread to rebind.`,
        8000,
      );
    }
  }

  async upsertThread(thread: Thread) {
    const i = this.threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) this.threads[i] = thread;
    else this.threads.push(thread);
    // Rethrow: callers show a "Failed to create thread" toast. Swallowing
    // here left the thread memory-only, silently vanishing on restart.
    await saveThread(thread);
  }

  async removeThread(id: string) {
    const removed = this.threads.find((t) => t.id === id);
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
      console.error("deleteThread failed:", err);
    }
  }

  setThreadStatus(id: string, status: ThreadStatus, exitCode: number | null = null) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    if (t.status === status && t.exitCode === exitCode) return;
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
    if (
      status === "done" ||
      status === "exited" ||
      status === "error" ||
      status === "stopped" ||
      status === "idle"
    ) {
      void saveThread($state.snapshot(t) as Thread);
    }
  }

  setThreadAutoSlept(id: string, value: boolean) {
    const t = this.threads.find((x) => x.id === id);
    if (!t || (t.autoSlept ?? false) === value) return;
    t.autoSlept = value;
    // Visual-only flag, never persisted. After a restart all threads come
    // back without the zZ animation; clicking re-spawns them like any
    // other stopped thread.
  }

  setThreadKeepAwake(id: string, value: boolean) {
    const t = this.threads.find((x) => x.id === id);
    if (!t || (t.keepAwake ?? false) === value) return;
    t.keepAwake = value;
    void saveThread($state.snapshot(t) as Thread);
  }

  toggleThreadKeepAwake(id: string) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    this.setThreadKeepAwake(id, !(t.keepAwake ?? false));
  }

  setThreadTitle(id: string, title: string) {
    // Named by hand: the agent's own titles stop applying to this thread.
    if (isRenamed(id)) return;
    const t = this.threads.find((x) => x.id === id);
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
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    const title = name?.trim() || null;
    t.title = title;
    // An OSC title queued just before the rename would land on top of it.
    this.pendingTitleSaves.delete(id);
    if (title) markRenamed(id);
    else clearRenamed(id);
    try {
      await updateThreadTitle(id, title, t.origin);
    } catch (err) {
      console.error("renameThread failed:", err);
      notifications.error("Failed to rename thread");
    }
  }

  setThreadPtyId(id: string, ptyId: string | null) {
    const t = this.threads.find((x) => x.id === id);
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
      console.error("registerProjectRoots failed:", err);
    }
  }

  async updateProject(project: Project) {
    const idx = this.projects.findIndex((p) => p.id === project.id);
    if (idx !== -1) this.projects[idx] = project;
    try {
      await saveProject(project);
    } catch (err) {
      console.error("saveProject failed:", err);
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
      console.error("renameProject failed:", err);
      notifications.error("Failed to rename project");
    }
  }

  async addProject(project: Project) {
    this.projects.push(project);
    await this.syncRoots();
    try {
      await saveProject(project);
    } catch (err) {
      console.error("saveProject failed:", err);
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
      console.error("archiveProject failed:", err);
    }
  }

  async unarchiveProject(id: string) {
    const p = this.projects.find((x) => x.id === id);
    if (!p || !p.archived) return;
    p.archived = false;
    try {
      await setProjectArchived(id, false, p.origin);
    } catch (err) {
      console.error("unarchiveProject failed:", err);
    }
  }

  async removeProject(id: string) {
    const removed = this.projects.find((p) => p.id === id);
    const orphanThreads = this.threads.filter((t) => t.projectId === id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.threads = this.threads.filter((t) => t.projectId !== id);
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
      console.error("deleteProject failed:", err);
    }
  }

}

export const app = new AppState();
