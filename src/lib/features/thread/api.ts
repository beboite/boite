import { app } from "$lib/app/store.svelte";
import { ptyKill } from "$lib/storage/pty";
import { getDefaultShell } from "$lib/storage/shell";
import { saveThread } from "$lib/storage/db";
import { parseCommand, settings } from "$lib/features/settings/store.svelte";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { platform } from "$lib/storage/platform.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { statusEngine } from "$lib/features/thread/statusEngine";
import type { IconKey, Shortcut, Thread } from "$lib/types";
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
    id: crypto.randomUUID(),
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

export async function launchShortcut(
  shortcut: Shortcut,
  projectId: string | null,
): Promise<Thread | null> {
  const project = projectId ? app.projects.find((p) => p.id === projectId) : null;
  if (!project) {
    notifications.error("Pick a project first");
    return null;
  }
  const parsed = parseCommand(shortcut.command || shortcut.label);
  if (!parsed.cmd) {
    notifications.error(`${shortcut.label}: empty command`);
    return null;
  }
  const count = nextLabelSuffix(project.id, shortcut.label);
  const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command);
  const thread = buildThread(
    project.id,
    parsed.cmd,
    parsed.args,
    `${shortcut.label} #${count}`,
    iconKey,
  );
  app.markFresh(thread.id);
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

export async function launchShell(
  shell: ShellOption,
  projectId: string | null,
): Promise<Thread | null> {
  const project = projectId ? app.projects.find((p) => p.id === projectId) : null;
  if (!project) {
    notifications.error("Pick a project first");
    return null;
  }
  const count = nextLabelSuffix(project.id, shell.label);
  const thread = buildThread(
    project.id,
    shell.cmd,
    [...shell.args],
    `${shell.label} #${count}`,
    "terminal",
  );
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

export async function launchBlankTerminal(
  projectId: string | null,
): Promise<Thread | null> {
  const project = projectId ? app.projects.find((p) => p.id === projectId) : null;
  if (!project) {
    notifications.error("Pick a project first");
    return null;
  }

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

  const count = nextLabelSuffix(project.id, label);
  const thread = buildThread(
    project.id,
    cmd,
    args,
    `${label} #${count}`,
    "terminal",
  );
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

export async function closeThread(threadId: string) {
  const t = app.threads.find((x) => x.id === threadId);
  if (t) rememberClosedThread(t);
  const kill = t?.ptyId ? ptyKill(t.ptyId, true).catch(() => {}) : Promise.resolve();
  await app.removeThread(threadId);
  await kill;
}

export async function stopThread(threadId: string) {
  const t = app.threads.find((x) => x.id === threadId);
  if (!t) return;

  const previousPtyId = t.ptyId;
  app.setThreadPtyId(t.id, null);
  app.setThreadStatus(t.id, "stopped", null);
  await saveThread({
    ...t,
    ptyId: null,
    status: "stopped",
    exitCode: null,
    args: [...t.args],
  });

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
    await app.upsertThread(restored);
    app.activeThreadId = restored.id;
    app.selectedProjectId = restored.projectId;
    app.view = "terminal";
    statusEngine.markViewed(restored.id);
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
    void ptyKill(previousPtyId, false).catch(() => {});
  }

  t.ptyId = null;
  t.status = "idle";
  t.exitCode = null;
  void saveThread({ ...t, args: [...t.args] }).catch((err) => {
    console.error("saveThread failed:", err);
  });

  app.activeThreadId = t.id;
  app.selectedProjectId = t.projectId;
  app.view = "terminal";
  statusEngine.markViewed(t.id);
  app.bumpRespawn(t.id);
}
