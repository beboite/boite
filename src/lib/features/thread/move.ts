/**
 * Moving a running conversation from one project to another.
 *
 * One machinery, two doors: the `thread_move` MCP tool an agent calls on
 * itself, and a thread card dragged onto another project. They both land here
 * so a move means the same thing however it was asked for.
 *
 * A thread is three things in three places — a row in the database, a live
 * process in a directory, and a transcript the CLI files somewhere of its own —
 * and a move has to take all three or it takes none. The transcript is the part
 * that is easy to miss: claude looks a session up under the directory it ran
 * in, so a thread that changes project silently loses `--resume` unless the
 * file follows it.
 */

import { app } from "$lib/app/store.svelte";
import { backendForPath } from "$lib/backend";
import { ptyKill } from "$lib/storage/pty";
import { settings } from "$lib/features/settings/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { paneStore } from "$lib/features/panes/store.svelte";
import { parkedLocal } from "$lib/backend/tauri/parked";
import { openWorktreeFor } from "./api";
import { carryTranscript, releaseClaudeSession } from "./session";
import { threadCwd } from "./cwd";
import type { Project, Thread } from "$lib/types";

export interface MoveResult {
  ok: boolean;
  /** Why not, in a sentence an agent can act on. Only set when `ok` is false. */
  reason?: string;
  /** Where the thread ended up, when it moved. */
  cwd?: string;
  /**
   * The worktree it left behind because that worktree still held work. Nothing
   * was destroyed; the directory is simply no longer any thread's.
   */
  keptWorktree?: string;
}

/**
 * Hands back the thread's worktree, or reports that it could not be.
 *
 * Never forces, for the same reason the close path never does: the backend
 * refuses while there are uncommitted files or commits on no branch, and that
 * refusal is what stops a move from sweeping away work an agent produced and
 * never named a branch for. A worktree that refuses is kept and reported.
 */
async function releaseSourceWorktree(
  thread: Thread,
  source: Project,
): Promise<string | null> {
  if (!thread.worktreePath) return null;
  const repo = source.gitRoot ?? source.cwd;
  try {
    await backendForPath(source.cwd).worktree.remove(repo, thread.worktreePath, false);
    return null;
  } catch (err) {
    logger.info("move", `kept ${thread.worktreePath}`, String(err));
    return thread.worktreePath;
  }
}

/** Drops the thread out of one project's manual order and onto the end of the other's. */
async function reorderAcross(threadId: string, fromProjectId: string, toProjectId: string) {
  const orders = settings.state.threadOrderByProject ?? {};
  const from = (orders[fromProjectId] ?? []).filter((id) => id !== threadId);
  const to = [...(orders[toProjectId] ?? []).filter((id) => id !== threadId), threadId];
  await settings.setThreadOrder(fromProjectId, from);
  await settings.setThreadOrder(toProjectId, to);
}

/**
 * What the agent is told the moment it comes back up, as the prompt its CLI
 * opens on. Written to it, not about it: it wakes in a directory that is not
 * the one it went to sleep in, and nothing else in the transcript says why.
 */
function landingPrompt(
  target: Project,
  cwd: string,
  keptWorktree: string | null,
  resumed: boolean,
  working: boolean,
): string {
  const lines = [
    `[boite] This thread has been moved to the project "${target.name}". You are now working in ${cwd}.`,
  ];
  // Said either way, because the agent cannot tell from the inside. Claiming
  // the conversation came along when it did not is the one thing that would
  // have it answer as if it remembered something it never read.
  lines.push(
    resumed
      ? "The conversation above came with you."
      : "No earlier conversation followed you here, so this one starts empty — ask before assuming what was already decided.",
  );
  if (keptWorktree) {
    lines.push(
      `Your previous worktree still held uncommitted work, so it was left behind at ${keptWorktree} rather than removed — nothing was lost, but it is no longer where you are.`,
    );
  }
  // Only a thread that was mid-answer is told to pick it back up. Every other
  // one was sitting at a prompt waiting for its user, and a move is not an
  // instruction: this line is the whole reason a thread that was doing nothing
  // used to start doing something the moment it was dragged.
  lines.push(
    working
      ? "Carry on from where you left off."
      : "Nothing is being asked of you by this message; wait for your next instruction.",
  );
  return lines.join(" ");
}

/**
 * Moves a thread, its process, its worktree and its conversation into another
 * project, then brings it back up there.
 *
 * The relaunch is part of the move rather than a step after it: the PTY runs in
 * a directory, so a thread cannot change project while its process is alive.
 * It is killed, everything is rearranged around it, and it comes back with
 * `--resume` pointed at the transcript that travelled with it — unless it had
 * no process to begin with, in which case it stays down and comes up over there
 * the next time the user asks for it.
 */
export async function moveThreadToProject(
  threadId: string,
  targetProjectId: string,
  opts: { note?: string; silent?: boolean } = {},
): Promise<MoveResult> {
  const thread = app.threadById(threadId);
  if (!thread) return { ok: false, reason: "no such thread" };
  if (thread.projectId === targetProjectId) {
    return { ok: true, cwd: threadCwd(thread, app.projects.find((p) => p.id === targetProjectId)) ?? undefined };
  }

  const source = app.projects.find((p) => p.id === thread.projectId) ?? null;
  const target = app.projects.find((p) => p.id === targetProjectId) ?? null;
  if (!target) return { ok: false, reason: "no such project" };
  if (!source) return { ok: false, reason: "this thread's project is gone" };

  // Local and remote are two machines. The process, the worktree and the
  // transcript all live on one of them, and none of the three can cross.
  if ((thread.origin ?? "local") !== (target.origin ?? "local")) {
    return {
      ok: false,
      reason: `"${target.name}" lives on the other workspace; a thread cannot move between machines`,
    };
  }

  // An archived project is a project the user put away, not one they refused.
  // Moving a thread into it is an unambiguous statement that it is in use.
  if (target.archived) await app.unarchiveProject(target.id);

  const fromCwd = threadCwd(thread, source) ?? source.cwd;

  // Both read before the kill below empties them, because what the thread was
  // doing decides what comes back up on the other side. A live PTY has to be
  // relaunched — a process cannot change directory under itself — but a thread
  // the user put to sleep stays asleep: it moves on disk and comes up in the new
  // folder whenever it is next woken. "running" and "waiting" are the statuses
  // that mean the agent's turn was still open, and the ones that earn being told
  // to carry on: a thread blocked on a permission prompt has a tool call pending
  // in its transcript, and coming back up with nothing said would abandon it.
  const wasAlive = !!thread.ptyId;
  const wasWorking = thread.status === "running" || thread.status === "waiting";

  // A pane split holds threads of one project side by side. This one is about
  // to belong to another, so it leaves the group before anything else moves.
  if (paneStore.groupOf(thread.id)) paneStore.unsplit(thread.id);

  // The session has to be nobody's before it can be resumed anywhere. Same
  // reasoning as an explicit reload: a background agent still holding it makes
  // claude refuse `--resume` and the thread lands in the agent picker instead.
  // Alongside the kill below rather than ahead of it — different processes, so
  // there was never an order to keep, only two waits to pay.
  const release = thread.sessionId
    ? releaseClaudeSession(fromCwd, thread.sessionId)
    : Promise.resolve(false);
  // A move is never a reattach: drop any park marker so the fresh PTY over
  // there is spawned rather than resumed against a directory it no longer runs
  // in.
  parkedLocal.delete(thread.id);
  const deadPtyId = thread.ptyId;
  // wait=true: git reads a worktree whose process still holds files open as
  // busy on Windows, and the release below would fail for a reason that has
  // nothing to do with whether there is work in it.
  await Promise.all([
    release,
    deadPtyId ? ptyKill(deadPtyId, true).catch(() => {}) : Promise.resolve(),
  ]);
  if (deadPtyId) {
    // Dropped from the row straight away rather than only in the moved copy
    // below: everything between here and there can fail, and a thread left
    // pointing at a dead PTY reads as running in the sidebar.
    app.setThreadPtyId(thread.id, null);
  }

  const keptWorktree = await releaseSourceWorktree(thread, source);
  let worktreePath: string | null = null;
  try {
    worktreePath = await openWorktreeFor(target, thread.id, thread.iconKey);
  } catch (err) {
    logger.warn("move", `${thread.id}: no worktree in ${target.name}`, String(err));
  }
  const toCwd = worktreePath ?? target.cwd;

  const resumable = await carryTranscript(thread, fromCwd, toCwd);

  const moved: Thread = {
    ...thread,
    args: [...thread.args],
    projectId: target.id,
    worktreePath,
    origin: target.origin,
    // An id the CLI cannot find over there is worse than no id: it refuses the
    // launch outright rather than starting fresh. Dropping it is what turns a
    // conversation that could not follow into a new one instead of an error.
    sessionId: resumable ? thread.sessionId : null,
    ptyId: null,
    status: "idle",
    exitCode: null,
    autoSlept: false,
  };
  try {
    await app.upsertThread(moved);
  } catch (err) {
    logger.error("move", `${thread.id}: could not persist the move`, String(err));
    return { ok: false, reason: `could not save the move: ${String(err)}` };
  }
  // The row is the thread's home; a failed reorder is cosmetic and must not
  // read as a failed move.
  await reorderAcross(thread.id, source.id, target.id).catch((err) => {
    logger.warn("move", `${thread.id}: order not updated`, String(err));
  });

  app.setPendingPrompt(
    thread.id,
    // Resumable only says the transcript is reachable. A thread that never had
    // a session had no conversation to carry either, and telling it one came
    // along is the one line that would have it answer as if it remembered
    // something it never read.
    opts.note?.trim() ||
      landingPrompt(
        target,
        toCwd,
        keptWorktree,
        resumable && !!thread.sessionId,
        wasWorking,
      ),
  );
  app.selectedProjectId = target.id;
  // Mounting a terminal is what spawns its PTY, so activating a sleeping thread
  // would launch it. The briefing stays queued instead and is handed over
  // whenever the user does wake it, in the folder it woke up in.
  if (wasAlive) {
    app.activeThreadId = thread.id;
    app.view = "terminal";
    app.bumpRespawn(thread.id);
  }

  logger.info("move", `${thread.id}: ${source.name} → ${target.name}`, {
    fromCwd,
    toCwd,
    keptWorktree,
  });
  if (!opts.silent) {
    notifications.success(
      t("thread.movedTo", {
        name: thread.title ?? thread.label,
        project: target.name,
      }),
    );
    if (keptWorktree) {
      // Neutral, and longer than the move above it. Nothing succeeded here: a
      // directory the move did not take along is still on disk, and the card
      // names the path because that is the only place it is ever said.
      notifications.info(t("worktree.keptAtPath", { path: keptWorktree }), 8000);
    }
  }
  return { ok: true, cwd: toCwd, keptWorktree: keptWorktree ?? undefined };
}
