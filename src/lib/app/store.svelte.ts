import type { Project, Thread, ThreadStatus, View } from "$lib/types";
import { loadProjects, saveProject, deleteProject } from "$lib/storage/db";
import { settings } from "$lib/features/settings/store.svelte";
import { platform } from "$lib/storage/platform.svelte";
import {
  loadThreads,
  saveThread,
  deleteThread as dbDeleteThread,
} from "$lib/storage/db";
import type { PtyInfo } from "$lib/storage/pty";

class AppState {
  projects = $state<Project[]>([]);
  threads = $state<Thread[]>([]);
  activeThreadId = $state<string | null>(null);
  selectedProjectId = $state<string | null>(null);
  view = $state<View>("terminal");
  ready = $state(false);

  get activeThread(): Thread | null {
    return this.threads.find((t) => t.id === this.activeThreadId) ?? null;
  }

  get currentProjectId(): string | null {
    if (this.activeThread) return this.activeThread.projectId;
    if (this.selectedProjectId) return this.selectedProjectId;
    return this.projects[0]?.id ?? null;
  }

  threadsByProject(projectId: string): Thread[] {
    return this.threads.filter((t) => t.projectId === projectId);
  }

  async init() {
    if (this.ready) return;
    await Promise.all([settings.init(), platform.init()]);
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
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) {
      this.activeThreadId = this.threads[0]?.id ?? null;
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
    t.status = status;
    t.exitCode = exitCode;
  }

  setThreadTitle(id: string, title: string) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    t.title = title;
    void saveThread($state.snapshot(t) as Thread);
  }

  setThreadPtyId(id: string, ptyId: string | null) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
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

  syncFromPtyList(list: PtyInfo[]) {
    for (const p of list) {
      const t = this.threads.find((x) => x.ptyId === p.id);
      if (!t) continue;
      t.title = p.title;
      if (p.exited) {
        t.status = p.exitCode === 0 ? "done" : "exited";
        t.exitCode = p.exitCode;
      }
    }
  }
}

export const app = new AppState();
