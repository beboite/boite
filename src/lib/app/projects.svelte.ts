import type { Project } from "$lib/types";
import {
  deleteProject,
  deleteThread as dbDeleteThread,
  saveProject,
  setProjectArchived,
} from "$lib/storage/db";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { workspace } from "$lib/backend";
import { SCRATCH_PROJECT_ID } from "$lib/domain/project";
import { makeScratchProject } from "$lib/features/project/scratch";
import { gitStore } from "$lib/features/git/store.svelte";
import { forgetProjectWork } from "$lib/features/thread/work-activity.svelte";
import { device } from "$lib/features/settings/device.svelte";
import { syncRoots } from "./hydrate";
import type { AppState } from "./store.svelte";

/**
 * Everything that changes a project row.
 *
 * Eight writes with one shape: touch the row in the store so the window updates
 * now, then persist, then say so with a toast if the persist fails. The store
 * keeps the arrays and the selection; this keeps what happens to a project.
 *
 * The order is not cosmetic. The row is changed first because the user clicked
 * and the sidebar has to answer, and the failure is a toast rather than a
 * rollback because a project that reverts under a user's hands is worse than
 * one that is out of step until the next boot.
 */

export async function updateProject(app: AppState, project: Project) {
  const idx = app.projects.findIndex((p) => p.id === project.id);
  if (idx !== -1) app.projects[idx] = project;
  try {
    await saveProject(project);
  } catch (err) {
    logger.error("app", "saveProject failed", err);
    notifications.error(t("app.saveProjectFailed"));
  }
}

/**
 * The name is only a label: it starts out as whatever `inspect()` guessed from
 * the folder, and nothing downstream keys off it, so a rename is a plain column
 * write. `cwd` stays put, and the folder on disk is untouched.
 */
export async function renameProject(app: AppState, id: string, name: string) {
  const p = app.projects.find((x) => x.id === id);
  const next = name.trim();
  if (!p || !next || p.name === next) return;
  p.name = next;
  try {
    await saveProject($state.snapshot(p) as Project);
  } catch (err) {
    logger.error("app", "renameProject failed", err);
    notifications.error(t("app.renameProjectFailed"));
  }
}

/**
 * Whether this project's agent threads get their own worktree.
 *
 * Writes an explicit boolean rather than clearing back to null: once the user
 * has said, moving the app-wide default must not silently move this project with
 * it. Only threads started after this see it, because a thread's directory is
 * decided when it is born and never again.
 *
 * Rolled back if the persist fails: a switch the user then acts on (launching a
 * thread they think will get a worktree) is not a name they can see is wrong.
 */
export async function setProjectWorktrees(app: AppState, id: string, enabled: boolean) {
  const p = app.projects.find((x) => x.id === id);
  if (!p || (p.worktrees ?? null) === enabled) return;
  const previous = p.worktrees;
  p.worktrees = enabled;
  try {
    await saveProject($state.snapshot(p) as Project);
  } catch (err) {
    p.worktrees = previous;
    logger.error("app", "setProjectWorktrees failed", err);
    notifications.error(t("app.worktreeSettingFailed"));
  }
}

/** Replaces this project's MCP allow-list, or clears it back to global defaults. */
export async function setProjectMcpServers(
  app: AppState,
  id: string,
  serverIds: string[] | null,
) {
  const p = app.projects.find((x) => x.id === id);
  if (!p) return;
  const current = p.mcpServerIds ?? null;
  if (JSON.stringify(current) === JSON.stringify(serverIds)) return;
  p.mcpServerIds = serverIds;
  try {
    await saveProject($state.snapshot(p) as Project);
  } catch (err) {
    logger.error("app", "setProjectMcpServers failed", err);
    notifications.error(t("app.mcpSettingFailed"));
  }
}

/**
 * The Scratch row, made and persisted if this workspace has none.
 *
 * Lazy on purpose: the sidebar hides it while it is empty, so seeding it at boot
 * would only have written a row nobody could see. Unarchived on the way out,
 * because launching into a project the user has put away has to put it back or
 * the thread lands somewhere the sidebar refuses to show.
 */
export async function ensureScratch(app: AppState): Promise<Project | null> {
  const already = app.projects.find((p) => p.id === SCRATCH_PROJECT_ID);
  if (already) {
    if (already.archived) await unarchiveProject(app, already.id);
    return already;
  }
  const scratch = await makeScratchProject(workspace.isDynamic ? "local" : undefined);
  if (!scratch) {
    notifications.error(t("app.noHomeFolder"));
    return null;
  }
  await addProject(app, scratch);
  return scratch;
}

export async function addProject(app: AppState, project: Project) {
  app.projects.push(project);
  // A project just added on the boite is one the user asked for by name, so it
  // joins this device's shown list on its own. Without this it would land in the
  // database and nowhere else, since dynamic mode shows only ticked projects.
  if (workspace.isDynamic && project.origin === "remote" && workspace.activeBoiteId) {
    device.setRemoteProjectShown(workspace.activeBoiteId, project.id, true);
  }
  await syncRoots(app);
  try {
    await saveProject(project);
  } catch (err) {
    logger.error("app", "saveProject failed", err);
    notifications.error(t("app.saveProjectFailed"));
  }
}

export async function archiveProject(app: AppState, id: string) {
  const p = app.projects.find((x) => x.id === id);
  if (!p || p.archived) return;
  p.archived = true;
  // The selection and the active thread cannot stay on a project the sidebar no
  // longer draws: every launch would aim at a row nothing shows.
  if (app.selectedProjectId === id) {
    app.selectedProjectId = app.sortedProjects[0]?.id ?? null;
  }
  if (app.activeThread?.projectId === id) {
    app.activeThreadId = null;
  }
  try {
    await setProjectArchived(id, true, p.origin);
  } catch (err) {
    logger.error("app", "archiveProject failed", err);
    notifications.error(t("app.archiveFailed"));
  }
}

export async function unarchiveProject(app: AppState, id: string) {
  const p = app.projects.find((x) => x.id === id);
  if (!p || !p.archived) return;
  p.archived = false;
  try {
    await setProjectArchived(id, false, p.origin);
  } catch (err) {
    logger.error("app", "unarchiveProject failed", err);
    notifications.error(t("app.unarchiveFailed"));
  }
}

export async function removeProject(app: AppState, id: string) {
  const removed = app.projects.find((p) => p.id === id);
  const orphanThreads = app.threads.filter((thread) => thread.projectId === id);
  app.projects = app.projects.filter((p) => p.id !== id);
  app.threads = app.threads.filter((thread) => thread.projectId !== id);
  // A selection pointing at a row that is gone is a project id nothing can
  // resolve, and every launch would refuse until the user clicked elsewhere.
  if (app.selectedProjectId === id) {
    app.selectedProjectId = app.sortedProjects[0]?.id ?? null;
  }
  gitStore.drop(id);
  // Its place in the smart order goes with it. A project added back later is a
  // project nothing has happened in yet, not one still holding last month's rank.
  forgetProjectWork(id);
  if (workspace.activeBoiteId) {
    device.setRemoteProjectShown(workspace.activeBoiteId, id, false);
  }
  void syncRoots(app);
  for (const thread of orphanThreads) {
    try {
      await dbDeleteThread(thread.id, thread.origin);
    } catch {
      // The project is going either way, and a row left behind for a project
      // that no longer exists is invisible rather than harmful.
    }
  }
  try {
    await deleteProject(id, removed?.origin);
  } catch (err) {
    logger.error("app", "deleteProject failed", err);
    notifications.error(t("app.removeProjectFailed"));
  }
}
