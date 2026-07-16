import { backendFor, workspace } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";
import type { WorkspaceOrigin } from "$lib/types";
import { app } from "$lib/app/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { basename } from "$lib/shared/utils/path";
import { techIconDataUrl } from "$lib/shared/icons/tech";
import { uuid } from "$lib/shared/utils/uuid";
import { folderBrowser } from "./folderBrowserStore.svelte";
import type { Project } from "$lib/types";

export async function pickAndAddProject(
  target?: WorkspaceOrigin,
): Promise<Project | null> {
  // The native dialog only browses THIS machine. In a remote workspace (and in
  // any browser/PWA, which has no native dialog) open the server-side folder
  // browser instead, so it lists the boite-server's filesystem and adds the
  // project on confirm. In dynamic mode the caller picks the target; "remote"
  // routes to the server-side browser too.
  const remoteTarget =
    workspace.isRemote ||
    !hasTauri() ||
    (workspace.isDynamic && target === "remote");
  if (remoteTarget) {
    folderBrowser.open = true;
    return null;
  }
  let selected: string | string[] | null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    selected = await open({ directory: true, multiple: false });
  } catch (err) {
    console.error("dialog open failed:", err);
    notifications.error("Could not open folder picker");
    return null;
  }
  if (!selected || Array.isArray(selected)) return null;
  return addProjectByPath(selected, workspace.isDynamic ? "local" : undefined);
}

export async function addProjectByPath(
  path: string,
  origin?: WorkspaceOrigin,
): Promise<Project | null> {
  const existing = app.projects.find(
    (p) => p.cwd === path && (!origin || (p.origin ?? "local") === origin),
  );
  if (existing) {
    app.selectedProjectId = existing.id;
    return existing;
  }

  let inspection: { name: string; icon: string | null; tech?: string | null };
  try {
    inspection = await backendFor(origin).project.inspect(path);
  } catch (err) {
    logger.warn("project", `inspect_project failed for ${path}, using fallback`, String(err));
    inspection = { name: basename(path) || "project", icon: null };
  }

  const project: Project = {
    id: uuid(),
    name: inspection.name,
    cwd: path,
    icon: iconFromInspection(inspection),
    archived: false,
    origin: workspace.isDynamic ? origin ?? "local" : undefined,
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

function iconFromInspection(inspection: {
  icon: string | null;
  tech?: string | null;
}): string | null {
  if (inspection.icon) return inspection.icon;
  if (inspection.tech) return techIconDataUrl(inspection.tech);
  return null;
}

export async function refreshProjectIcon(project: Project): Promise<boolean> {
  let inspection: { name: string; icon: string | null; tech?: string | null };
  try {
    inspection = await backendFor(project.origin).project.inspect(project.cwd);
  } catch (err) {
    logger.warn("project", `re-inspect failed for ${project.cwd}`, String(err));
    return false;
  }
  const icon = iconFromInspection(inspection);
  if (!icon || icon === project.icon) return false;
  await app.updateProject({ ...project, icon });
  return true;
}

// Projects added before icon detection improved (or before their logo
// existed) are stuck with the initial; retry them quietly on startup.
export async function reinspectMissingIcons(): Promise<void> {
  const missing = app.projects.filter((p) => !p.icon);
  for (const project of missing) {
    try {
      await refreshProjectIcon(project);
    } catch {
      // best effort
    }
  }
}
