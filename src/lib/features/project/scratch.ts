/**
 * Making the Scratch project, which is the half of it that needs a backend.
 *
 * What Scratch *is* — its fixed id, and how to recognise one — lives in
 * `$lib/domain/project`, because five other features need to recognise one and
 * each import of it from here was a cycle. What it is *called* on screen lives
 * in `$lib/shared/project-label`, because that needs the current locale.
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
import { SCRATCH_PROJECT_ID } from "$lib/domain/project";
import { logger } from "$lib/shared/services/logger.svelte";
import type { Project, WorkspaceOrigin } from "$lib/types";

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
