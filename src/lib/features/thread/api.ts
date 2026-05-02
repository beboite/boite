import { app } from "$lib/app/store.svelte";
import { ptyKill } from "$lib/storage/pty";
import { getDefaultShell } from "$lib/storage/shell";
import { parseCommand } from "$lib/features/settings/store.svelte";
import type { Shortcut, Thread } from "$lib/types";

function buildThread(
  projectId: string,
  cmd: string,
  args: string[],
  label: string,
): Thread {
  return {
    id: crypto.randomUUID(),
    projectId,
    ptyId: null,
    label,
    title: null,
    cmd,
    args,
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
  if (!project) return null;
  const parsed = parseCommand(shortcut.command || shortcut.label);
  if (!parsed.cmd) return null;
  const count = app.threadsByProject(project.id).length + 1;
  const thread = buildThread(
    project.id,
    parsed.cmd,
    parsed.args,
    `${shortcut.label} #${count}`,
  );
  await app.upsertThread(thread);
  app.activeThreadId = thread.id;
  app.view = "terminal";
  return thread;
}

export async function launchBlankTerminal(
  projectId: string | null,
): Promise<Thread | null> {
  const project = projectId ? app.projects.find((p) => p.id === projectId) : null;
  if (!project) return null;
  const shell = await getDefaultShell();
  const count = app.threadsByProject(project.id).length + 1;
  const thread = buildThread(project.id, shell, [], `Terminal #${count}`);
  await app.upsertThread(thread);
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
