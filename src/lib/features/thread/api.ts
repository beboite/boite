import { app } from "$lib/app/store.svelte";
import { backendForPath, workspace } from "$lib/backend";
import { ptyKill } from "$lib/storage/pty";
import { getDefaultShell } from "$lib/storage/shell";
import { saveThread } from "$lib/storage/db";
import { parseCommand, settings } from "$lib/features/settings/store.svelte";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { platform } from "$lib/storage/platform.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { uuid } from "$lib/shared/utils/uuid";
import { parkedLocal } from "$lib/backend/tauri/parked";
import type { IconKey, Project, Shortcut, Thread } from "$lib/types";
import type { ShellOption } from "$lib/storage/platform.svelte";

const closedThreads: Thread[] = [];
const MAX_CLOSED_THREADS = 20;

function snapshotThread(thread: Thread): Thread {
  return {
    ...thread,
    args: [...thread.args],
    ptyId: null,
    status: "idle",
    exitCode: null,
  };
}

function rememberClosedThread(thread: Thread) {
  closedThreads.push(snapshotThread(thread));
  if (closedThreads.length > MAX_CLOSED_THREADS) closedThreads.shift();
}

function nextLabelSuffix(projectId: string, prefix: string): number {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped} #(\\d+)$`);
  let max = 0;
  for (const t of app.threadsByProject(projectId)) {
    const m = re.exec(t.label);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function buildThread(
  project: Project,
  cmd: string,
  args: string[],
  label: string,
  iconKey: IconKey,
  iconColor: string | null = null,
): Thread {
  return {
    id: uuid(),
    projectId: project.id,
    ptyId: null,
    label,
    title: null,
    cmd,
    args,
    iconKey,
    iconColor,
    sessionId: null,
    status: "idle",
    exitCode: null,
    createdAt: Date.now(),
    // A thread lives where its project lives (dynamic mode routing).
    origin: project.origin,
  };
}

function requireProject(projectId: string | null): Project | null {
  const project = projectId
    ? app.projects.find((p) => p.id === projectId) ?? null
    : null;
  if (!project) notifications.error("Pick a project first");
  return project;
}

/**
 * The worktree a new thread starts in, or null to run in the project folder.
 *
 * Decided once, when the thread is born, never at spawn time: a thread that
 * already exists has a directory the user has been working in, and moving it
 * out from under them on a relaunch would lose that.
 *
 * Detached, so nothing is named and no branch appears until the agent claims
 * one. Every refusal below falls back to the project folder — a thread that
 * cannot be isolated still has to start.
 */
async function openWorktreeFor(
  project: Project,
  threadId: string,
  iconKey: IconKey,
): Promise<string | null> {
  if (!settings.state.threadWorktrees) return null;
  // A blank terminal is the user's own shell: dev servers, logs and manual
  // git all have to run where the user is looking, not in a clean checkout.
  if (iconKey === "terminal") return null;

  const repo = project.gitRoot ?? project.cwd;
  const backend = backendForPath(project.cwd);
  try {
    const info = await backend.git.repoInfo(repo);
    if (!info.isRepo) return null;
    // "Look at what I just changed" cannot be answered from a clean worktree.
    // A dirty main checkout means the work under discussion is there, so the
    // thread starts there too.
    const dirty = await backend.git.status(repo);
    if (dirty.length > 0) return null;
    return await backend.worktree.open(repo, threadId);
  } catch (err) {
    logger.warn("worktree", `no worktree for ${threadId}`, String(err));
    return null;
  }
}

async function createThread(
  project: Project,
  cmd: string,
  args: string[],
  labelPrefix: string,
  iconKey: IconKey,
  opts: { fresh?: boolean; iconColor?: string | null } = {},
): Promise<Thread | null> {
  const count = nextLabelSuffix(project.id, labelPrefix);
  const thread = buildThread(
    project,
    cmd,
    args,
    `${labelPrefix} #${count}`,
    iconKey,
    opts.iconColor ?? null,
  );
  if (opts.fresh) app.markFresh(thread.id);
  thread.worktreePath = await openWorktreeFor(project, thread.id, iconKey);
  try {
    await app.upsertThread(thread);
  } catch (err) {
    console.error("upsertThread failed:", err);
    notifications.error("Failed to create thread");
    return null;
  }
  app.activeThreadId = thread.id;
  app.view = "terminal";
  return thread;
}

export async function launchShortcut(
  shortcut: Shortcut,
  projectId: string | null,
): Promise<Thread | null> {
  const project = requireProject(projectId);
  if (!project) return null;
  const parsed = parseCommand(shortcut.command || shortcut.label);
  if (!parsed.cmd) {
    notifications.error(`${shortcut.label}: empty command`);
    return null;
  }
  const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command);
  return createThread(project, parsed.cmd, parsed.args, shortcut.label, iconKey, {
    fresh: true,
    iconColor: shortcut.iconColor ?? null,
  });
}

export async function launchShell(
  shell: ShellOption,
  projectId: string | null,
): Promise<Thread | null> {
  const project = requireProject(projectId);
  if (!project) return null;
  return createThread(project, shell.cmd, [...shell.args], shell.label, "terminal");
}

export async function launchBlankTerminal(
  projectId: string | null,
): Promise<Thread | null> {
  const project = requireProject(projectId);
  if (!project) return null;

  let cmd: string;
  let args: string[] = [];
  let label = "Terminal";

  // A remote project in dynamic mode runs on the boite: the locally-configured
  // shell doesn't exist there, so always take the server's default.
  const crossRemote = workspace.isDynamic && project.origin === "remote";
  const preferred =
    !crossRemote && settings.state.defaultShellId
      ? platform.shells.find((s) => s.id === settings.state.defaultShellId)
      : null;
  if (preferred) {
    cmd = preferred.cmd;
    args = [...preferred.args];
    label = preferred.label;
  } else {
    cmd = await getDefaultShell(project.origin);
  }

  return createThread(project, cmd, args, label, "terminal");
}

/**
 * Gives back the thread's worktree, unless it is still holding something.
 *
 * Never forces. The backend refuses while there are uncommitted files or
 * commits on no branch, and that refusal is the whole safety net: an agent
 * that produced something real and never claimed a branch keeps its directory
 * instead of having it swept. Only empty worktrees are collected.
 */
async function releaseWorktree(t: Thread) {
  if (!t.worktreePath) return;
  const project = app.projects.find((p) => p.id === t.projectId);
  if (!project) return;
  const repo = project.gitRoot ?? project.cwd;
  try {
    await backendForPath(project.cwd).worktree.remove(repo, t.worktreePath, false);
  } catch (err) {
    logger.info("worktree", `kept ${t.worktreePath}`, String(err));
    notifications.success(`Kept the worktree for ${t.title ?? t.label}: it still has work in it.`);
  }
}

export async function closeThread(threadId: string) {
  const t = app.threadById(threadId);
  if (t) rememberClosedThread(t);
  const kill = t?.ptyId ? ptyKill(t.ptyId, true).catch(() => {}) : Promise.resolve();
  await app.removeThread(threadId);
  await kill;
  // After the PTY is gone: git reads a worktree whose process still holds
  // files open as busy on Windows, and the removal would fail for a reason
  // that has nothing to do with whether there is work in it.
  if (t) await releaseWorktree(t);
}

// One close path for every entry point (sidebar X, context menu, Ctrl+W) so
// the confirm-before-close setting is honored everywhere.
export async function closeThreadWithConfirm(threadId: string): Promise<boolean> {
  const t = app.threadById(threadId);
  if (!t) return false;
  if (settings.state.confirmCloseThread) {
    const ok = await confirmDialog.ask({
      title: "Close thread?",
      message: `Close ${t.title ?? t.label}? Running process will be killed.`,
      confirmLabel: "Close thread",
      danger: true,
    });
    if (!ok) return false;
  }
  await closeThread(threadId);
  return true;
}

export async function stopThread(threadId: string) {
  const t = app.threadById(threadId);
  if (!t) return;

  const previousPtyId = t.ptyId;
  app.setThreadPtyId(t.id, null);
  parkedLocal.delete(t.id);
  // setThreadStatus persists terminal statuses itself.
  app.setThreadStatus(t.id, "stopped", null);

  if (previousPtyId) {
    try {
      await ptyKill(previousPtyId, true);
    } catch {
      // already exited
    }
  }
}

export async function restoreLastClosedThread(): Promise<Thread | null> {
  while (closedThreads.length > 0) {
    const thread = closedThreads.pop();
    if (!thread) break;
    if (!app.projects.some((p) => p.id === thread.projectId)) {
      continue;
    }

    const restored = snapshotThread(thread);
    try {
      await app.upsertThread(restored);
    } catch (err) {
      console.error("upsertThread failed:", err);
      notifications.error("Failed to restore thread");
      return null;
    }
    app.activeThreadId = restored.id;
    app.selectedProjectId = restored.projectId;
    app.view = "terminal";
    notifications.success(`Restored ${restored.title ?? restored.label}`);
    return restored;
  }

  notifications.error("No closed thread to restore");
  return null;
}

export async function reloadThread(threadId: string) {
  const t = app.threadById(threadId);
  if (!t) return;

  const previousPtyId = t.ptyId;
  // An explicit relaunch is never a reattach: drop any park marker so the fresh
  // PTY gets its launch input typed.
  parkedLocal.delete(t.id);

  // Reload means "give me this conversation here, now". If a background agent
  // is still holding the session, claude would refuse to resume it and the
  // thread would land in the agent picker instead — so release it first and let
  // the relaunch below be an ordinary resume. Stopping is scoped to background
  // agents backend-side; an interactive session belongs to another terminal.
  // Best-effort: a failure just means the picker path is taken, as before.
  if (t.sessionId) {
    const project = app.projects.find((p) => p.id === t.projectId);
    if (project) {
      await backendForPath(project.cwd)
        .session.stopClaude(t.sessionId)
        .catch(() => false);
    }
  }
  if (previousPtyId) {
    // wait=true: respawning before the old process is dead reopens the
    // two-`claude --resume`-on-one-session-file race the backend kill
    // semantics were built to prevent.
    await ptyKill(previousPtyId, true).catch(() => {});
  }

  t.ptyId = null;
  t.status = "idle";
  t.exitCode = null;
  t.autoSlept = false;
  void saveThread({ ...t, args: [...t.args] }).catch((err) => {
    console.error("saveThread failed:", err);
  });

  app.activeThreadId = t.id;
  app.selectedProjectId = t.projectId;
  app.view = "terminal";
  app.bumpRespawn(t.id);
}
