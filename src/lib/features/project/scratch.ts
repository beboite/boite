/**
 * The project for threads that are not about a project yet.
 *
 * Boite used to have nothing to open a terminal in but a folder someone had
 * already decided was a project, which is the wrong way round for how work
 * actually starts: an idea gets talked through first, and only then does it
 * earn a repository. Scratch is where that conversation happens — the user's
 * home folder, no worktree, no git panel worth looking at — until
 * `createProject` gives it somewhere to live and the thread moves in.
 *
 * It is an ordinary project row rather than a special case in the schema. Every
 * thing a thread needs — a cwd, a todo list, the MCP endpoint's project lookup,
 * the sidebar's grouping — already keys off a project, and a nullable project
 * would have meant teaching each of them what "nowhere" means.
 *
 * Made the first time something is launched into it, not at boot, and hidden
 * from the sidebar again once its last thread is gone: a row that is only ever
 * a starting point should not sit there being one of the things being worked
 * on. Nothing is lost by it disappearing, since the next launch makes it back
 * under the same fixed id.
 */

import { backendFor } from "$lib/backend";
import { t } from "$lib/i18n/index.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import type { Project, WorkspaceOrigin } from "$lib/types";

/**
 * Fixed rather than generated: the row is recreated on a machine that has never
 * had one, and a thread that moved out of it must not find a second one waiting
 * under a different id after a reinstall.
 */
export const SCRATCH_PROJECT_ID = "boite-scratch";

export function isScratch(project: { id: string } | null | undefined): boolean {
  return project?.id === SCRATCH_PROJECT_ID;
}

/**
 * The name to put on screen for a project.
 *
 * Scratch is the app's own row, not something the user named, so it reads in
 * the app's language. The stored `name` column stays English: it is what the
 * MCP endpoint and the logs match on, and translating a database value would
 * make a French install and an English one disagree about the same row.
 */
export function projectDisplayName(project: { id: string; name: string }): string {
  return isScratch(project) ? t("project.scratch") : project.name;
}

/**
 * A fresh Scratch row, or null when the home folder cannot be resolved — there
 * is nowhere to run, and a project pointing at nothing is worse than none.
 *
 * The caller persists it; this only decides what it looks like.
 */
export async function makeScratchProject(
  origin?: WorkspaceOrigin,
): Promise<Project | null> {
  let home: string;
  try {
    home = await backendFor(origin).project.homeDir();
  } catch (err) {
    logger.warn("scratch", "no home folder, skipping the scratch project", String(err));
    return null;
  }
  if (!home) return null;

  return {
    id: SCRATCH_PROJECT_ID,
    name: "Scratch",
    cwd: home,
    icon: null,
    archived: false,
    origin,
  };
}
