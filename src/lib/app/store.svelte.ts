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
  deleteThread as dbDeleteThread,
} from "$lib/storage/db";

class AppState {
  projects = $state<Project[]>([]);
  threads = $state<Thread[]>([]);
  activeThreadId = $state<string | null>(null);
  selectedProjectId = $state<string | null>(null);
  view = $state<View>("terminal");
  ready = $state(false);
  respawnNonce = $state<Record<string, number>>({});
  freshThreadIds = new Set<string>();

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
    try {
      this.threads = await loadThreads();
    } catch (err) {
      console.error("loadThreads failed:", err);
    }
    this.ready = true;
  }

  async upsertThread(thread: Thread) {
    const i = this.threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) this.threads[i] = thread;
    else this.threads.push(thread);
    try {
      await saveThread(thread);
    } catch (err) {
      console.error("saveThread failed:", err);
    }
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
    if (status !== "stopped" && t.autoSlept) t.autoSlept = false;
    if (status === "done" || status === "exited" || status === "error") {
      void saveThread($state.snapshot(t) as Thread);
    }
  }

  setThreadAutoSlept(id: string, value: boolean) {
    const t = this.threads.find((x) => x.id === id);
    if (!t || (t.autoSlept ?? false) === value) return;
    t.autoSlept = value;
  }

  setThreadTitle(id: string, title: string) {
    const t = this.threads.find((x) => x.id === id);
    if (!t || t.title === title) return;
    t.title = title;
    void saveThread($state.snapshot(t) as Thread);
  }

  setThreadPtyId(id: string, ptyId: string | null) {
    const t = this.threads.find((x) => x.id === id);
    if (!t || t.ptyId === ptyId) return;
    t.ptyId = ptyId;
  }

  async addProject(project: Project) {
    this.projects.push(project);
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
