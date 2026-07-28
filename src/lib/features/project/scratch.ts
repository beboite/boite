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
 */

import { backendFor } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import type { Project, WorkspaceOrigin } from "$lib/types";

/**
 * Fixed rather than generated: the row is recreated from scratch on a machine
 * that has never had one, and a thread that moved out of it must not find a
 * second one waiting under a different id after a reinstall.
 */
export const SCRATCH_PROJECT_ID = "boite-scratch";

export function isScratch(project: { id: string } | null | undefined): boolean {
  return project?.id === SCRATCH_PROJECT_ID;
}

/**
 * The Scratch row, made if this workspace has never had one.
 *
 * Seeded at boot rather than on first use: an empty Boite with no way to open a
 * terminal is the state this exists to remove, so it has to be there before the
 * user looks. Returns null when the home folder cannot be resolved — there is
 * nowhere to run, and a project pointing at nothing is worse than none.
 */
export async function ensureScratchProject(
  existing: Project[],
  origin?: WorkspaceOrigin,
): Promise<Project | null> {
  const already = existing.find((p) => p.id === SCRATCH_PROJECT_ID);
  if (already) return already;

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
