import { backendFor, workspace } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";
import type { FolderState } from "$lib/backend/types";
import type { WorkspaceOrigin } from "$lib/types";
import { app } from "$lib/app/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { basename, dirname } from "$lib/shared/utils/path";
import { folderNameFor, joinPath, samePath } from "./path";
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

/**
 * Where a project with no path of its own goes.
 *
 * The folder that already holds the most projects, because that is the answer
 * the user gave by putting them there. Home only when there is nothing to learn
 * from — a first project, or projects scattered one per folder.
 */
async function defaultParentFolder(origin?: WorkspaceOrigin): Promise<string> {
  const counts = new Map<string, number>();
  for (const p of app.projects) {
    if ((p.origin ?? "local") !== (origin ?? "local")) continue;
    const parent = dirname(p.cwd);
    if (!parent) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1;
  for (const [parent, count] of counts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  if (best) return best;
  return backendFor(origin).project.homeDir();
}

export interface CreateProjectRequest {
  name: string;
  /** The exact folder. Takes precedence over `parent`. */
  path?: string;
  /** The folder to put it in; the project's own is named after it. */
  parent?: string;
  /** Accept a folder that already has files in it. */
  adopt?: boolean;
  /** Run `git init` unless the folder is already a repository. Default true. */
  git?: boolean;
  origin?: WorkspaceOrigin;
}

export interface CreateProjectResult {
  ok: boolean;
  /** Why not, in a sentence the caller can act on. */
  reason?: string;
  project?: Project;
  /** How it came about, when it was not made from nothing. */
  reused?: "existing" | "unarchived";
}

/**
 * Turns an idea into a project: a folder, a repository, and a row in the
 * sidebar.
 *
 * Written for two callers with the same needs — the user, and an agent calling
 * `project_create` on a conversation it wants to give a home. Both can name a
 * project that is already there, and both mean the same thing by it: use that
 * one. An archived project is a project the user put away, and asking for it
 * again is an unambiguous statement that it is back in use.
 *
 * A folder that already has files in it is the one case that refuses. Adding a
 * project on top of somebody's work is not reversible in the way the others
 * are, and `adopt` exists so the answer is given deliberately rather than
 * assumed.
 */
export async function createProject(
  req: CreateProjectRequest,
): Promise<CreateProjectResult> {
  const name = req.name.trim();
  if (!name) return { ok: false, reason: "a project needs a name" };
  const origin = req.origin ?? (workspace.isDynamic ? "local" : undefined);

  const path =
    req.path?.trim() ||
    joinPath(
      req.parent?.trim() || (await defaultParentFolder(origin)),
      folderNameFor(name),
    );

  const existing = app.projects.find(
    (p) => samePath(p.cwd, path) && (p.origin ?? "local") === (origin ?? "local"),
  );
  if (existing) {
    const wasArchived = existing.archived;
    if (wasArchived) await app.unarchiveProject(existing.id);
    app.selectedProjectId = existing.id;
    logger.info("project", `reused ${existing.name}`, { cwd: existing.cwd, wasArchived });
    return {
      ok: true,
      project: existing,
      reused: wasArchived ? "unarchived" : "existing",
    };
  }

  const backend = backendFor(origin);
  let state: FolderState;
  try {
    state = await backend.project.folderState(path);
  } catch (err) {
    return { ok: false, reason: `cannot look at ${path}: ${String(err)}` };
  }
  if (state === "occupied" && !req.adopt) {
    return {
      ok: false,
      reason: `${path} already has files in it. Pass adopt to take it over, or pick another path.`,
    };
  }
  if (state === "missing") {
    try {
      await backend.project.createFolder(path);
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  let inspection: { name: string; icon: string | null; tech?: string | null };
  try {
    inspection = await backend.project.inspect(path);
  } catch (err) {
    logger.warn("project", `inspect failed for ${path}`, String(err));
    inspection = { name, icon: null };
  }

  const project: Project = {
    id: uuid(),
    // The name that was asked for wins over the one the folder suggests: the
    // caller just chose it, and inspect() is guessing from a folder that is
    // usually empty at this point anyway.
    name,
    cwd: path,
    icon: iconFromInspection(inspection),
    archived: false,
    origin,
  };
  try {
    await app.addProject(project);
  } catch (err) {
    return { ok: false, reason: `could not add the project: ${String(err)}` };
  }

  // After addProject: the folder only becomes a registered root once the
  // project exists, and git commands refuse paths outside those roots.
  if (req.git !== false) {
    try {
      const info = await backend.git.repoInfo(path);
      if (!info.isRepo) await backend.git.init(path);
    } catch (err) {
      // A project without a repository is still a project. Say so and move on
      // rather than unwinding a folder the user can see.
      logger.warn("project", `git init skipped for ${path}`, String(err));
      notifications.error(`Created ${name}, but git init failed: ${String(err)}`);
    }
  }

  app.selectedProjectId = project.id;
  logger.info("project", `created ${project.name}`, { cwd: project.cwd });
  return { ok: true, project };
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

// Each inspection is several read_dir + read_to_string round trips, and this
// runs right as the user starts interacting. A small sliding window keeps the
// wall time at roughly the slowest project instead of the sum of all of them,
// without letting N projects fan out into N concurrent directory walks.
const ICON_REINSPECT_CONCURRENCY = 4;

// Projects added before icon detection improved (or before their logo
// existed) are stuck with the initial; retry them quietly on startup.
export async function reinspectMissingIcons(): Promise<void> {
  const missing = app.projects.filter((p) => !p.icon);
  if (missing.length === 0) return;

  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const project = missing[next++];
      try {
        await refreshProjectIcon(project);
      } catch {
        // best effort
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(ICON_REINSPECT_CONCURRENCY, missing.length) },
      worker,
    ),
  );
}
