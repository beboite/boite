import { loadProjects, saveProject, deleteProject } from "./db";
import { settings } from "./settings.svelte";
import type { PtyInfo } from "./pty";

export interface Project {
  id: string;
  name: string;
  cwd: string;
  defaultCmd: string;
  defaultArgs: string[];
  icon: string | null;
}

export interface Thread {
  id: string;
  projectId: string;
  ptyId: string | null;
  label: string;
  title: string | null;
  cmd: string;
  args: string[];
  status: "idle" | "running" | "ready" | "done" | "exited" | "error";
  exitCode: number | null;
  createdAt: number;
}

export type View = "terminal" | "settings";

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
    await settings.init();
    try {
      this.projects = await loadProjects();
    } catch (err) {
      console.error("loadProjects failed:", err);
    }
    this.ready = true;
  }

  upsertThread(thread: Thread) {
    const i = this.threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) this.threads[i] = thread;
    else this.threads.push(thread);
  }

  removeThread(id: string) {
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) {
      this.activeThreadId = this.threads[0]?.id ?? null;
    }
  }

  setThreadStatus(id: string, status: Thread["status"], exitCode: number | null = null) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    t.status = status;
    t.exitCode = exitCode;
  }

  setThreadTitle(id: string, title: string) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    t.title = title;
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
    this.projects = this.projects.filter((p) => p.id !== id);
    this.threads = this.threads.filter((t) => t.projectId !== id);
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
