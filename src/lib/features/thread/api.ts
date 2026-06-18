import { app } from "$lib/app/store.svelte";
import { ptyKill } from "$lib/storage/pty";
import { getDefaultShell } from "$lib/storage/shell";
import { saveThread } from "$lib/storage/db";
import { parseCommand, settings } from "$lib/features/settings/store.svelte";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { platform } from "$lib/storage/platform.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { uuid } from "$lib/shared/utils/uuid";
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
  projectId: string,
  cmd: string,
  args: string[],
  label: string,
  iconKey: IconKey,
): Thread {
  return {
    id: uuid(),
    projectId,
    ptyId: null,
    label,
    title: null,
    cmd,
    args,
    iconKey,
    sessionId: null,
    status: "idle",
    exitCode: null,
    createdAt: Date.now(),
  };
}

function requireProject(projectId: string | null): Project | null {
  const project = projectId
    ? app.projects.find((p) => p.id === projectId) ?? null
    : null;
  if (!project) notifications.error("Pick a project first");
  return project;
}

async function createThread(
  project: Project,
  cmd: string,
  args: string[],
  labelPrefix: string,
  iconKey: IconKey,
  opts: { fresh?: boolean } = {},
): Promise<Thread | null> {
  const count = nextLabelSuffix(project.id, labelPrefix);
  const thread = buildThread(
    project.id,
    cmd,
    args,
    `${labelPrefix} #${count}`,
    iconKey,
  );
  if (opts.fresh) app.markFresh(thread.id);
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

  const preferred = settings.state.defaultShellId
    ? platform.shells.find((s) => s.id === settings.state.defaultShellId)
    : null;
  if (preferred) {
    cmd = preferred.cmd;
    args = [...preferred.args];
    label = preferred.label;
  } else {
    cmd = await getDefaultShell();
  }

  return createThread(project, cmd, args, label, "terminal");
}

export async function closeThread(threadId: string) {
  const t = app.threads.find((x) => x.id === threadId);
  if (t) rememberClosedThread(t);
  const kill = t?.ptyId ? ptyKill(t.ptyId, true).catch(() => {}) : Promise.resolve();
  await app.removeThread(threadId);
  await kill;
}

// One close path for every entry point (sidebar X, context menu, Ctrl+W) so
// the confirm-before-close setting is honored everywhere.
export async function closeThreadWithConfirm(threadId: string): Promise<boolean> {
  const t = app.threads.find((x) => x.id === threadId);
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
  const t = app.threads.find((x) => x.id === threadId);
  if (!t) return;

  const previousPtyId = t.ptyId;
  app.setThreadPtyId(t.id, null);
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
  const t = app.threads.find((x) => x.id === threadId);
  if (!t) return;

  const previousPtyId = t.ptyId;
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
