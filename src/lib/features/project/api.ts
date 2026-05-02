import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { app } from "$lib/app/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import type { Project } from "$lib/types";

interface ProjectInspection {
  name: string;
  icon: string | null;
}

export async function pickAndAddProject(): Promise<Project | null> {
  let selected: string | string[] | null;
  try {
    selected = await open({ directory: true, multiple: false });
  } catch (err) {
    console.error("dialog open failed:", err);
    notifications.error("Could not open folder picker");
    return null;
  }
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
    icon: inspection.icon,
  };
  try {
    await app.addProject(project);
  } catch (err) {
    console.error("addProject failed:", err);
    notifications.error("Failed to add project");
    return null;
  }
  app.selectedProjectId = project.id;
  notifications.success(`Added ${project.name}`);
  return project;
}

function deriveBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "project";
}
