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
import { t } from "$lib/i18n/index.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { uuid } from "$lib/shared/utils/uuid";
import { parkedLocal } from "$lib/backend/tauri/parked";
import { isScratch } from "$lib/features/project/scratch";
import {
  comboArgs,
  iconKeyForKind,
  FASTPICK_CMD,
  type FastpickCombo,
} from "$lib/features/fastpick/combo";
import { barColorArgs } from "$lib/features/fastpick/threadAccent";
import { samePromotion, type Promotion } from "./promote";
import { releaseClaudeSession } from "./session";
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
  if (!project) notifications.error(t("thread.pickProjectFirst"));
  return project;
}

/**
 * The project a launch aims at: the one the user is on, or Scratch.
 *
 * Two ways to reach Scratch, because it is no longer a row to click: being on
 * no project at all, which is what the sidebar's empty space leaves you with,
 * or asking for it outright — shift-click or right-click on a shortcut, which
 * works without giving up the project you are on.
 *
 * Async because Scratch is made on demand, so every launch path awaits it
 * before it has a project id to pass on.
 */
export async function launchTargetProjectId(
  forceScratch = false,
): Promise<string | null> {
  if (!forceScratch) {
    const current = app.currentProjectId;
    if (current) return current;
  }
  const scratch = await app.ensureScratch();
  return scratch?.id ?? null;
}

/**
 * A blank terminal wherever the user currently is, Scratch included. The form
 * every keyboard and palette entry wants: they have no project in hand, only
 * the rule for finding one.
 */
export async function launchBlankTerminalHere(
  forceScratch = false,
): Promise<Thread | null> {
  const projectId = await launchTargetProjectId(forceScratch);
  return projectId ? launchBlankTerminal(projectId) : null;
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
export async function openWorktreeFor(
  project: Project,
  threadId: string,
  iconKey: IconKey,
): Promise<string | null> {
  // The project's own answer when it has one, the app's otherwise. A project
  // that has never been asked stays on the default, so flipping the global
  // still moves every project nobody has decided for.
  if (!(project.worktrees ?? settings.state.threadWorktrees)) return null;
  // A blank terminal is the user's own shell: dev servers, logs and manual
  // git all have to run where the user is looking, not in a clean checkout.
  if (iconKey === "terminal") return null;
  // Scratch is the home folder, not a project. A home directory that happens to
  // be a repository is somebody's dotfiles, and a thread that started there did
  // not start there to work on them.
  if (isScratch(project)) return null;

  const repo = project.gitRoot ?? project.cwd;
  try {
    // One call, not three. Whether the repo qualifies at all is decided
    // backend-side now: asking "is this a repo" and "is it clean" from here
    // cost two more round trips and two more `git` processes, and on Windows
    // the process spawns are what a new thread actually waits on.
    return await backendForPath(project.cwd).worktree.open(repo, threadId);
  } catch (err) {
    logger.warn("worktree", `no worktree for ${threadId}`, String(err));
    return null;
  }
}

// Repositories already asked for a spare, and when they were asked. The backend
// refills after every thread that takes one, so a project only has to be primed
// once — but never for the whole session: a spare removed from the Worktrees
// tab, or dropped by the pool's own cap, has to be replaceable without a
// restart.
const warmed = new Map<string, number>();
const WARM_TTL = 5 * 60_000;

// The same path is two different repositories in dynamic mode: one on this
// machine, one on the boite. Keyed on both, or landing on the remote project
// would be told the local one had already been warmed.
function warmKey(project: Project): string {
  return `${project.origin ?? "local"}:${project.gitRoot ?? project.cwd}`;
}

/**
 * Forgets that this project was warmed, so the next visit asks again.
 *
 * The one thing this side cannot observe is the pool losing a spare — removed
 * by hand from the Worktrees tab, or collected by the backend's own cap — and
 * without this the project would go without one until a restart.
 */
export function forgetWarmedWorktree(project: Project) {
  warmed.delete(warmKey(project));
}

/**
 * Asks for a worktree to be standing by for this project's next agent thread.
 *
 * Called when the user moves to a project, which is the earliest honest sign
 * that something is about to be launched in it, and far enough ahead of the
 * click that `git worktree add` is finished before it comes. Without this the
 * checkout happened between the click and the terminal, where it was measured at
 * half a second on a small repository and seconds on a large one.
 *
 * Never awaited, and a refusal is not reported: a project with no spare is the
 * behaviour every project had before this existed.
 */
export function warmWorktreeFor(project: Project | null) {
  if (!project) return;
  if (!(project.worktrees ?? settings.state.threadWorktrees)) return;
  if (isScratch(project)) return;
  const key = warmKey(project);
  const now = Date.now();
  // Swept here rather than on a timer: this is the only thing that ever puts an
  // entry in, so it is the only place one can have gone stale.
  for (const [k, at] of warmed) {
    if (now - at >= WARM_TTL) warmed.delete(k);
  }
  if (warmed.has(key)) return;
  warmed.set(key, now);
  void backendForPath(project.cwd)
    .worktree.warm(project.gitRoot ?? project.cwd)
    .catch((err) => {
      warmed.delete(key);
      logger.info("worktree", `no spare for ${project.name}`, String(err));
    });
}

// Threads whose working directory is still being decided.
//
// A thread is created and shown before its worktree exists, so `git worktree
// add` no longer sits between the click and the sidebar. The directory still
// has to be final before anything runs in it: a PTY started in the project
// folder cannot be moved once it is up, and its agent session would be looked
// up under the wrong path for the rest of the thread's life.
const preparing = new Map<string, Promise<void>>();

/**
 * Resolves once this thread's working directory is final.
 *
 * An unknown id resolves immediately: a thread that is not mid-creation
 * already has the directory it keeps for the rest of its life.
 */
export function threadDirectoryReady(threadId: string): Promise<void> {
  return preparing.get(threadId) ?? Promise.resolve();
}

function prepareWorktree(project: Project, thread: Thread, iconKey: IconKey) {
  const work = (async () => {
    const path = await openWorktreeFor(project, thread.id, iconKey);
    if (!path) return;
    // The store's thread, not the local one: that is the reactive object the
    // terminal reads its cwd from. It is gone when the thread was closed while
    // the worktree was being made — the close path waits for us before
    // releasing, so there is nothing left to write to.
    const live = app.threadById(thread.id);
    if (!live) return;
    live.worktreePath = path;
    await saveThread({ ...live, args: [...live.args] });
  })();

  preparing.set(
    thread.id,
    work
      .catch((err) => {
        // A thread with no worktree runs in the project folder, which is the
        // documented fallback — never a reason to fail the thread itself.
        logger.warn("worktree", `prepare failed for ${thread.id}`, String(err));
      })
      .finally(() => {
        preparing.delete(thread.id);
      }),
  );
}

/**
 * Says which directory a thread that never reached SQLite left behind.
 *
 * The row is what a restart reads, so without it the worktree opened for this
 * thread is registered in git and owned by nobody: no thread claims it, no
 * cleanup path knows it exists, and the Worktrees tab is the only place it can
 * still be found. Removing it here is not on offer — the terminal is starting
 * in it as this runs — so naming it is what is left, in the log and in the
 * toast, rather than losing it quietly.
 */
async function recordUnsavedThread(thread: Thread, err: unknown) {
  await threadDirectoryReady(thread.id);
  const orphan = app.threadById(thread.id)?.worktreePath ?? null;
  logger.error("thread", `${thread.id}: not saved, it is gone on restart`, {
    error: String(err),
    orphanWorktree: orphan,
  });
  notifications.error(
    orphan ? t("thread.notSavedOrphan", { path: orphan }) : t("thread.notSaved"),
  );
}

/**
 * Synchronous, and that is the point: a launch has nothing left to wait for.
 * The row goes to SQLite behind the caller and the worktree is opened behind the
 * thread, so between the click and a thread the user can see there is no round
 * trip left to pay.
 */
function createThread(
  project: Project,
  cmd: string,
  args: string[],
  labelPrefix: string,
  iconKey: IconKey,
  opts: { fresh?: boolean; iconColor?: string | null } = {},
): Thread {
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
  // Not awaited. The thread is in the store the moment this returns, which is
  // all the sidebar and the terminal need; waiting for the INSERT to come back
  // put an IPC round trip and a WAL commit between the click and the pane. A
  // row that fails to land still gives a working thread for this session, and
  // says so.
  void app.upsertThread(thread).catch((err) => recordUnsavedThread(thread, err));
  app.activeThreadId = thread.id;
  app.view = "terminal";
  // After the thread exists, never before it: the worktree is several `git`
  // processes and the user was watching an empty sidebar for all of them.
  prepareWorktree(project, thread, iconKey);
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
    notifications.error(t("thread.emptyCommand", { label: shortcut.label }));
    return null;
  }
  const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command);
  return createThread(project, parsed.cmd, parsed.args, shortcut.label, iconKey, {
    fresh: true,
    iconColor: shortcut.iconColor ?? null,
  });
}

/**
 * Applies what a process said its thread had become, and persists it.
 *
 * The label is left alone. It is the user's word for this terminal, numbered per project,
 * and a thread they renamed does not want a launcher renaming it back. The command is not:
 * rewriting it is the whole point, since that is what a reload replays.
 */
export async function promoteThread(
  threadId: string,
  promotion: Promotion,
): Promise<void> {
  const thread = app.threadById(threadId);
  if (!thread || samePromotion(thread, promotion)) return;
  thread.cmd = promotion.cmd;
  thread.args = [...promotion.args];
  thread.iconKey = promotion.iconKey;
  try {
    await saveThread({ ...thread, args: [...thread.args] });
  } catch (err) {
    logger.warn("thread", `promotion not persisted for ${threadId}`, String(err));
  }
}

/**
 * Starts an agent through fastpick, on a combination the user picked here.
 *
 * The thread's command carries all three answers, which is what makes fastpick resolve
 * without opening its own menu — and what makes a reload come back on the same endpoint and
 * the same model instead of asking again. The label and the icon are the agent's, not
 * fastpick's: from here on it is a Claude thread that happens to run somewhere else, and
 * the status, the session monitor and the todo endpoint all key off that.
 */
export async function launchFastpick(
  combo: FastpickCombo,
  harness: { name: string; kind: string },
  projectId: string | null,
): Promise<Thread | null> {
  const project = requireProject(projectId);
  if (!project) return null;
  return createThread(
    project,
    FASTPICK_CMD,
    [...comboArgs(combo), ...barColorArgs(combo, harness.kind)],
    harness.name,
    iconKeyForKind(harness.kind),
    { fresh: true },
  );
}

/**
 * Starts an agent from an already-resolved command, in a project the caller has
 * in hand.
 *
 * The door `thread_spawn` comes through. `launchShortcut` cannot serve it: what
 * an agent names is a CLI or one of the user's shortcuts, resolved before we
 * get here, and a project it may not be sitting in — while `launchShortcut`
 * looks a project up by id and complains to the user when it finds none, which
 * is the wrong conversation to have about a request nobody clicked.
 */
export async function launchAgent(
  project: Project,
  launch: {
    cmd: string;
    args: string[];
    label: string;
    iconKey: IconKey;
    iconColor?: string | null;
  },
): Promise<Thread | null> {
  return createThread(
    project,
    launch.cmd,
    [...launch.args],
    launch.label,
    launch.iconKey,
    { fresh: true, iconColor: launch.iconColor ?? null },
  );
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
async function releaseWorktree(thread: Thread) {
  if (!thread.worktreePath) return;
  const project = app.projects.find((p) => p.id === thread.projectId);
  if (!project) return;
  const repo = project.gitRoot ?? project.cwd;
  try {
    await backendForPath(project.cwd).worktree.remove(repo, thread.worktreePath, false);
  } catch (err) {
    logger.info("worktree", `kept ${thread.worktreePath}`, String(err));
    notifications.success(
      t("worktree.keptForThread", { thread: thread.title ?? thread.label }),
    );
  }
}

export async function closeThread(threadId: string) {
  // Closed before its worktree landed: the directory would be created a moment
  // after the release below read a null path, and stay behind forever.
  await threadDirectoryReady(threadId);
  const thread = app.threadById(threadId);
  if (thread) rememberClosedThread(thread);
  const kill = thread?.ptyId
    ? ptyKill(thread.ptyId, true).catch(() => {})
    : Promise.resolve();
  await app.removeThread(threadId);
  await kill;
  // After the PTY is gone: git reads a worktree whose process still holds
  // files open as busy on Windows, and the removal would fail for a reason
  // that has nothing to do with whether there is work in it.
  if (thread) await releaseWorktree(thread);
}

// One close path for every entry point (sidebar X, context menu, Ctrl+W) so
// the confirm-before-close setting is honored everywhere.
export async function closeThreadWithConfirm(threadId: string): Promise<boolean> {
  const thread = app.threadById(threadId);
  if (!thread) return false;
  if (settings.state.confirmCloseThread) {
    const ok = await confirmDialog.ask({
      title: "Close thread?",
      message: `Close ${thread.title ?? thread.label}? Running process will be killed.`,
      confirmLabel: "Close thread",
      danger: true,
    });
    if (!ok) return false;
  }
  await closeThread(threadId);
  return true;
}

export async function stopThread(threadId: string) {
  const thread = app.threadById(threadId);
  if (!thread) return;

  const previousPtyId = thread.ptyId;
  app.setThreadPtyId(thread.id, null);
  parkedLocal.delete(thread.id);
  // setThreadStatus persists terminal statuses itself.
  app.setThreadStatus(thread.id, "stopped", null);

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
    // Same as a launch: the row is in the store already, so nothing the user is
    // about to look at is waiting on the write.
    void app.upsertThread(restored).catch((err) => recordUnsavedThread(restored, err));
    app.activeThreadId = restored.id;
    app.selectedProjectId = restored.projectId;
    app.view = "terminal";
    notifications.success(
      t("thread.restored", { name: restored.title ?? restored.label }),
    );
    return restored;
  }

  notifications.error(t("thread.noClosedThread"));
  return null;
}

export async function reloadThread(threadId: string) {
  const thread = app.threadById(threadId);
  if (!thread) return;

  const previousPtyId = thread.ptyId;
  // An explicit relaunch is never a reattach: drop any park marker so the fresh
  // PTY gets its launch input typed.
  parkedLocal.delete(thread.id);

  // Reload means "give me this conversation here, now". If a background agent
  // is still holding the session, claude would refuse to resume it and the
  // thread would land in the agent picker instead — so release it first and let
  // the relaunch below be an ordinary resume. Stopping is scoped to background
  // agents backend-side; an interactive session belongs to another terminal.
  // Best-effort: a failure just means the picker path is taken, as before.
  //
  // Together with the kill, not before it. The two touch different processes:
  // a background agent somewhere else, and this pane's own PTY, so nothing
  // ordered them; running them in series only stacked one wait on top of the
  // other, and the release alone can spend three seconds waiting for a SIGTERM
  // to land.
  const project = app.projects.find((p) => p.id === thread.projectId);
  const release =
    thread.sessionId && project
      ? releaseClaudeSession(project.cwd, thread.sessionId)
      : Promise.resolve(false);
  // wait=true: respawning before the old process is dead reopens the
  // two-`claude --resume`-on-one-session-file race the backend kill semantics
  // were built to prevent.
  const kill = previousPtyId
    ? ptyKill(previousPtyId, true).catch(() => {})
    : Promise.resolve();
  await Promise.all([release, kill]);

  thread.ptyId = null;
  thread.status = "idle";
  thread.exitCode = null;
  thread.autoSlept = false;
  void saveThread({ ...thread, args: [...thread.args] }).catch((err) => {
    logger.error("thread", "saveThread failed", String(err));
  });

  app.activeThreadId = thread.id;
  app.selectedProjectId = thread.projectId;
  app.view = "terminal";
  app.bumpRespawn(thread.id);
}
