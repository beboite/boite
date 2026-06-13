import type { Project, Thread, ThreadStatus, View } from "$lib/types";
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
import { gitStore } from "$lib/features/git/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { backend } from "$lib/backend";
import type { ControlEvent } from "$lib/backend/types";

class AppState {
  projects = $state<Project[]>([]);
  threads = $state<Thread[]>([]);
  activeThreadId = $state<string | null>(null);
  selectedProjectId = $state<string | null>(null);
  view = $state<View>("terminal");
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
        void updateThreadTitle(id, title).catch((err) => {
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

  get sortedProjects(): Project[] {
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
  }

  get archivedProjects(): Project[] {
    return this.projects
      .filter((p) => p.archived)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

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

    try {
      this.projects = await loadProjects();
    } catch (err) {
      console.error("loadProjects failed:", err);
    }
    // Before ready: panels start polling fs/git commands as soon as they
    // mount, and those commands reject paths outside registered roots.
    await this.syncRoots();
    try {
      this.threads = await loadThreads();
    } catch (err) {
      console.error("loadThreads failed:", err);
    }
    this.deduplicateSessionIds();

    // Remote: the server is authoritative for thread runtime state and pushes
    // it as control events. Local has no subscribe and derives status itself.
    const be = backend();
    if (be.subscribe) {
      this.#unsubscribeControl = be.subscribe((ev) => this.applyControlEvent(ev));
    }

    this.ready = true;
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
        if (t) t.title = (data?.title as string) ?? t.title;
        break;
      }
      case "thread.created": {
        const incoming = ev.data as Thread;
        if (incoming?.id && !this.threads.some((x) => x.id === incoming.id)) {
          this.threads.push(incoming);
        }
        break;
      }
      case "thread.updated": {
        const id = data?.id as string | undefined;
        const t = id ? this.threads.find((x) => x.id === id) : undefined;
        if (t) Object.assign(t, data);
        break;
      }
      case "thread.deleted": {
        const id = data?.threadId as string | undefined;
        if (id) this.threads = this.threads.filter((x) => x.id !== id);
        break;
      }
      case "project.changed": {
        void loadProjects()
          .then((p) => {
            this.projects = p;
          })
          .catch(() => {});
        break;
      }
    }
  }

  // Legacy fix: pre-0.5.5 builds could let multiple threads capture the
  // same session id. We can't know which thread was the "real" owner, so
  // when a collision is detected we null EVERY conflicting thread. Each one
  // respawns fresh on next wake; user rebinds via /resume in the AI CLI.
  private deduplicateSessionIds() {
    const withSession = this.threads.filter((t) => t.sessionId);
    console.info(
      `[boite] session dedup: ${this.threads.length} threads loaded, ${withSession.length} with sessionId`,
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
    try {
      await dbDeleteThread(id);
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
      // Route through setThreadAutoSlept so the flag clear is persisted;
      // otherwise auto-slept threads keep their zZ animation in DB even
      // after the user wakes them, and reappear asleep on next launch.
      this.setThreadAutoSlept(id, false);
    }
    // Remote: the server persists runtime state and pushes it back; a client
    // write would clobber it. Only the local backend persists status here.
    if (!backend().caps.clientStatus) return;
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
    const t = this.threads.find((x) => x.id === id);
    if (!t || t.title === title) return;
    t.title = title;
    // Remote owns the title (parsed server-side, pushed as a control event).
    if (!backend().caps.clientStatus) return;
    this.pendingTitleSaves.set(id, title);
    this.scheduleTitleFlush();
  }

  setThreadPtyId(id: string, ptyId: string | null) {
    const t = this.threads.find((x) => x.id === id);
    if (!t || t.ptyId === ptyId) return;
    t.ptyId = ptyId;
  }

  private async syncRoots() {
    try {
      await registerProjectRoots(this.projects.map((p) => p.cwd));
    } catch (err) {
      console.error("registerProjectRoots failed:", err);
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
      await setProjectArchived(id, true);
    } catch (err) {
      console.error("archiveProject failed:", err);
    }
  }

  async unarchiveProject(id: string) {
    const p = this.projects.find((x) => x.id === id);
    if (!p || !p.archived) return;
    p.archived = false;
    try {
      await setProjectArchived(id, false);
    } catch (err) {
      console.error("unarchiveProject failed:", err);
    }
  }

  async removeProject(id: string) {
    const orphanThreads = this.threads.filter((t) => t.projectId === id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.threads = this.threads.filter((t) => t.projectId !== id);
    gitStore.drop(id);
    void this.syncRoots();
    for (const t of orphanThreads) {
      try {
        await dbDeleteThread(t.id);
      } catch {
        // ignore
      }
    }
    try {
      await deleteProject(id);
    } catch (err) {
      console.error("deleteProject failed:", err);
    }
  }

}

export const app = new AppState();
