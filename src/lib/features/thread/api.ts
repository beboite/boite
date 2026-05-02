import { app } from "$lib/app/store.svelte";
import { ptyKill } from "$lib/storage/pty";
import { getDefaultShell } from "$lib/storage/shell";
import { parseCommand, settings } from "$lib/features/settings/store.svelte";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { platform } from "$lib/storage/platform.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import type { IconKey, Shortcut, Thread } from "$lib/types";
import type { ShellOption } from "$lib/storage/platform.svelte";

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
  const count = app.threadsByProject(project.id).length + 1;
  const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command);
  const thread = buildThread(
    project.id,
    parsed.cmd,
    parsed.args,
    `${shortcut.label} #${count}`,
    iconKey,
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

export async function launchShell(
  shell: ShellOption,
  projectId: string | null,
): Promise<Thread | null> {
  const project = projectId ? app.projects.find((p) => p.id === projectId) : null;
  if (!project) {
    notifications.error("Pick a project first");
    return null;
  }
  const count = app.threadsByProject(project.id).length + 1;
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

  const count = app.threadsByProject(project.id).length + 1;
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
  if (t?.ptyId) {
    try {
      await ptyKill(t.ptyId);
    } catch {
      // already exited
    }
  }
  await app.removeThread(threadId);
}
