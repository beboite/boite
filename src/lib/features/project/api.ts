import { open } from "@tauri-apps/plugin-dialog";
import { backend } from "$lib/backend";
import { app } from "$lib/app/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { basename } from "$lib/shared/utils/path";
import type { Project } from "$lib/types";

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
  return addProjectByPath(selected);
}

export async function addProjectByPath(path: string): Promise<Project | null> {
  const existing = app.projects.find((p) => p.cwd === path);
  if (existing) {
    app.selectedProjectId = existing.id;
    return existing;
  }

  let inspection: { name: string; icon: string | null };
  try {
    inspection = await backend().project.inspect(path);
  } catch (err) {
    logger.warn("project", `inspect_project failed for ${path}, using fallback`, String(err));
    inspection = { name: basename(path) || "project", icon: null };
  }

  const project: Project = {
    id: crypto.randomUUID(),
    name: inspection.name,
    cwd: path,
    icon: inspection.icon,
    archived: false,
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
  logger.info("project", `added project ${project.name}`, { cwd: project.cwd });
  return project;
}
