import type { Project, Thread } from "$lib/types";
import { saveThread, updateThreadTitle } from "$lib/storage/db";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { workspace } from "$lib/backend";
import { isRenamed } from "$lib/features/thread/renamed";
import { isGenericTitle } from "$lib/features/thread/title-filter";
import { isScratch } from "$lib/domain/project";
import { notifications } from "$lib/features/notifications/store.svelte";
import type { AppState } from "./store.svelte";

/**
 * What boot has to fix in rows an older Boite wrote.
 *
 * Three passes that run once, between the rows landing and the app being ready,
 * and none of them is about how the app works now. They were in the store next
 * to the methods that do, where the only thing they had in common was being
 * long.
 *
 * They share a shape worth keeping together: each finds rows carrying an answer
 * a past version gave, writes the answer this version would give, and never
 * fails boot over it. A repair that throws is worse than the state it was
 * repairing, because the state at least starts.
 *
 * Order matters and is set by the caller: `migrateWorktrees` has to follow
 * `syncRoots`, since the backend refuses a repository it has no root for, and
 * it has to land before a terminal mounts, since mounting is what spawns a PTY
 * in the directory it is about to move.
 */

/**
 * Drops titles a past version let through and this one would refuse.
 *
 * The filter runs when a title arrives, so a name it did not know about yet,
 * `fastpick` announcing its own image path before the agent it launches gets to
 * speak, was written to the row and outlives the fix: the thread is idle, no new
 * title is coming, and the sidebar keeps showing an executable path until
 * someone renames it by hand. Widening the set has to reach the rows already
 * wearing the old answer.
 *
 * A name the user typed is left alone, and so is a remote row: the server owns
 * those titles and re-pushes them, so writing here would be undone anyway.
 */
export function dropGenericTitles(app: AppState) {
  for (const thread of app.threads) {
    if (!thread.title || isRenamed(thread.id)) continue;
    if (!isGenericTitle(thread.title)) continue;
    thread.title = null;
    if (!workspace.backendFor(thread.origin).caps.clientStatus) continue;
    void updateThreadTitle(thread.id, null, thread.origin).catch((err) => {
      logger.warn("app", `could not clear generic title for ${thread.id}`, String(err));
    });
  }
}

/**
 * Breaks a session id two threads both think they own.
 *
 * Pre-0.5.5 builds could let several threads capture the same one. Which of
 * them was the real owner is not knowable, so a collision clears every thread
 * in it: each respawns fresh on the next wake and the user rebinds with
 * `/resume` in the agent's own CLI.
 *
 * Remote rows are left alone. The server owns session bindings, so this would
 * write back through `thread.create` over state it owns, and tell the user to
 * type `/resume` somewhere that means nothing.
 */
export function deduplicateSessionIds(app: AppState) {
  const sniffable = app.threads.filter(
    (thread) => workspace.backendFor(thread.origin).caps.clientStatus,
  );
  if (sniffable.length === 0) return;
  const withSession = sniffable.filter((thread) => thread.sessionId);
  // Written where the log can be read back rather than to the console: a
  // packaged desktop app has no console open, which is the whole reason the app
  // log exists.
  logger.debug(
    "app",
    `session dedup: ${sniffable.length} threads loaded, ${withSession.length} with sessionId`,
  );
  const bySession = new Map<string, Thread[]>();
  for (const thread of withSession) {
    const list = bySession.get(thread.sessionId as string) ?? [];
    list.push(thread);
    bySession.set(thread.sessionId as string, list);
  }
  let cleared = 0;
  for (const [sid, threads] of bySession) {
    if (threads.length < 2) continue;
    const labels = threads.map((thread) => thread.label).join(", ");
    logger.warn(
      "app",
      `sessionId ${sid} shared by ${threads.length} threads (${labels}); clearing all to break cross-talk`,
    );
    for (const thread of threads) {
      thread.sessionId = null;
      app.markUnbound(thread.id);
      cleared++;
      void saveThread($state.snapshot(thread) as Thread);
    }
  }
  if (cleared > 0) {
    logger.warn(
      "app",
      `cleared ${cleared} legacy thread session bindings; each needs /resume to rebind`,
    );
    notifications.error(t("app.clearedSessionBindings", { count: cleared }), 8000);
  }
}

/**
 * Brings worktrees left outside their project back into it.
 *
 * One thread at a time, deliberately. Two `git worktree move` in the same
 * repository fight over its lock, and threads of one project are the common
 * case.
 */
export async function migrateWorktrees(app: AppState) {
  let adopted = 0;
  for (const thread of app.threads) {
    const project = app.projects.find((p) => p.id === thread.projectId);
    if (!project) continue;
    if (!thread.worktreePath) {
      adopted += (await adoptForgotten(thread, project)) ? 1 : 0;
      continue;
    }
    await moveIntoProject(thread, project);
  }
  if (adopted > 0) {
    notifications.success(t("worktree.adoptedBack", { count: adopted }));
  }
}

/**
 * Looks for a checkout a thread with no path may still own.
 *
 * The `gone` branch below clears the row on one unreadable answer, and the
 * directory it forgot is still there. Left forgotten, the thread runs in the
 * user's own project folder while claiming isolation, and `--resume` looks for
 * its transcript under a directory the agent never ran in, which reads as "No
 * conversation found with session ID" for a session that exists.
 *
 * Only asked for a thread that could have had one. A blank terminal and a
 * scratch thread never do, and asking is a filesystem walk per thread at every
 * boot.
 */
async function adoptForgotten(thread: Thread, project: Project): Promise<boolean> {
  if (thread.iconKey === "terminal" || isScratch(project)) return false;
  try {
    const found = await workspace
      .backendFor(thread.origin)
      .worktree.adopt(project.gitRoot ?? project.cwd, thread.id);
    if (!found) return false;
    thread.worktreePath = found;
    await saveThread($state.snapshot(thread) as Thread);
    logger.info("worktree", `adopted ${found} back for ${thread.id}`);
    return true;
  } catch (err) {
    // Nothing is lost by not answering: the thread keeps running in the project
    // folder, exactly as it did before this existed.
    logger.warn("worktree", `could not look for a worktree for ${thread.id}`, String(err));
    return false;
  }
}

async function moveIntoProject(thread: Thread, project: Project) {
  try {
    const answer = await workspace
      .backendFor(thread.origin)
      .worktree.migrate(project.gitRoot ?? project.cwd, thread.id, thread.worktreePath as string);
    // A directory that is not there any more. Kept, the thread spawned its PTY
    // in it and the launch failed on a path nobody could see, every start,
    // forever. Forgotten, the thread runs in the project folder, which is what a
    // thread with no worktree has always done.
    if (answer.gone) {
      logger.info("worktree", `forgot ${thread.worktreePath} for ${thread.id}`, "it is gone");
      thread.worktreePath = null;
      await saveThread($state.snapshot(thread) as Thread);
      return;
    }
    // No path is the answer for every worktree already in its project, which
    // after the first launch is all of them.
    if (!answer.path) return;
    thread.worktreePath = answer.path;
    await saveThread($state.snapshot(thread) as Thread);
  } catch (err) {
    // One that will not move keeps the path it has, and the thread starts in it
    // exactly as it did before. Never a reason to hold up boot.
    logger.warn("worktree", `kept ${thread.worktreePath} for ${thread.id}`, String(err));
  }
}
