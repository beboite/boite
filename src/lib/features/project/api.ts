import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { app } from "$lib/app/store.svelte";
import type { Project } from "$lib/types";

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
