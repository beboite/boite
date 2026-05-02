import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { app, type Project, type Thread } from "./store.svelte";
import { parseCommand, type Shortcut } from "./settings.svelte";

interface ProjectInspection {
  name: string;
  icon: string | null;
}

export async function pickAndAddProject(): Promise<Project | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  const path = selected;

  const existing = app.projects.find((p) => p.cwd === path);
  if (existing) {
    app.selectedProjectId = existing.id;
    return existing;
  }

  let inspection: ProjectInspection;
  try {
    inspection = await invoke<ProjectInspection>("inspect_project", { path });
  } catch (err) {
    console.error("inspect_project failed:", err);
    inspection = { name: deriveBasename(path), icon: null };
  }

  const project: Project = {
    id: crypto.randomUUID(),
    name: inspection.name,
    cwd: path,
    defaultCmd: "",
    defaultArgs: [],
    icon: inspection.icon,
  };
  await app.addProject(project);
  app.selectedProjectId = project.id;
  return project;
}

function deriveBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "project";
}

export function launchShortcut(shortcut: Shortcut, projectId: string | null): Thread | null {
  const project = projectId ? app.projects.find((p) => p.id === projectId) : null;
  if (!project) return null;
  const parsed = parseCommand(shortcut.command || shortcut.label);
  if (!parsed.cmd) return null;
  const id = crypto.randomUUID();
  const count = app.threadsByProject(project.id).length + 1;
  const thread: Thread = {
    id,
    projectId: project.id,
    ptyId: null,
    label: `${shortcut.label} #${count}`,
    title: null,
    cmd: parsed.cmd,
    args: parsed.args,
    status: "idle",
    exitCode: null,
    createdAt: Date.now(),
  };
  app.upsertThread(thread);
  app.activeThreadId = id;
  app.view = "terminal";
  return thread;
}
