import { app } from "$lib/app/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { projectDisplayName } from "$lib/features/project/scratch";
import {
  closeThreadWithConfirm,
  launchBlankTerminalHere,
  launchShortcut,
  launchTargetProjectId,
  restoreLastClosedThread,
} from "$lib/features/thread/api";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { t } from "$lib/i18n/index.svelte";
import type { MessageKey } from "$lib/i18n/messages";
import type { IconKey } from "$lib/types";

export type PaletteSection = "threads" | "actions" | "projects";

export interface PaletteCommand {
  id: string;
  section: PaletteSection;
  label: string;
  hint?: string;
  /** Same glyph the sidebar row wears, so a thread is recognised before it is read. */
  icon?: { key: IconKey; color: string | null };
  run: () => void | Promise<unknown>;
}

// Ranking bias when a query is active: a thread you can jump to beats an
// action of the same textual score, which beats selecting a project.
export const SECTION_BIAS: Record<PaletteSection, number> = {
  threads: 6,
  actions: 3,
  projects: 0,
};

// Keys rather than strings: the section headers are drawn by a component that
// only knows the section, so the literal has to live on the data.
export const SECTION_TITLE_KEYS: Record<PaletteSection, MessageKey> = {
  threads: "palette.threads",
  actions: "palette.actions",
  projects: "palette.projects",
};

function goToThread(threadId: string, projectId: string) {
  app.activeThreadId = threadId;
  app.selectedProjectId = projectId;
  app.view = "terminal";
  app.mobileTab = "terminal";
}

// Rebuilt on every palette open: cheap (a few array maps) and always current.
export function buildPaletteCommands(): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  for (const project of app.sortedProjects) {
    for (const thread of app.threadsByProjectSorted(project.id)) {
      // What the sidebar row says, in the same order: a thread's title is its
      // name, and "Claude #3" is the fallback for one that never got a title.
      // The slot label stays in the hint so it is still searchable.
      commands.push({
        id: `thread:${thread.id}`,
        section: "threads",
        label: thread.title ?? thread.label,
        hint: thread.title
          ? `${projectDisplayName(project)} — ${thread.label}`
          : projectDisplayName(project),
        icon: { key: thread.iconKey, color: thread.iconColor ?? null },
        run: () => goToThread(thread.id, project.id),
      });
    }
  }

  commands.push({
    id: "action:new-terminal",
    section: "actions",
    label: t("palette.newTerminal"),
    hint: "Ctrl+T",
    run: () => launchBlankTerminalHere(),
  });
  for (const shortcut of settings.state.shortcuts) {
    commands.push({
      id: `action:shortcut:${shortcut.id}`,
      section: "actions",
      label: t("palette.launch", { label: shortcut.label }),
      hint: shortcut.command,
      icon: {
        key: resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command),
        color: shortcut.iconColor ?? null,
      },
      run: async () => {
        const projectId = await launchTargetProjectId();
        if (projectId) await launchShortcut(shortcut, projectId);
      },
    });
  }
  commands.push({
    id: "action:restore-thread",
    section: "actions",
    label: t("palette.restoreThread"),
    hint: "Ctrl+Shift+T",
    run: () => restoreLastClosedThread(),
  });
  if (app.activeThreadId) {
    const id = app.activeThreadId;
    commands.push({
      id: "action:close-thread",
      section: "actions",
      label: t("palette.closeThread"),
      hint: "Ctrl+W",
      run: () => closeThreadWithConfirm(id),
    });
  }
  commands.push(
    {
      id: "action:toggle-sidebar",
      section: "actions",
      label: t("palette.toggleSidebar"),
      hint: "Ctrl+B",
      run: () => settings.toggleSidebar(),
    },
    {
      id: "action:toggle-git",
      section: "actions",
      label: t("palette.toggleGit"),
      run: () => settings.toggleRightPanel("git"),
    },
    {
      id: "action:toggle-explorer",
      section: "actions",
      label: t("palette.toggleExplorer"),
      run: () => settings.toggleRightPanel("explorer"),
    },
    {
      id: "action:toggle-todo",
      section: "actions",
      label: t("palette.toggleTodo"),
      run: () => settings.toggleRightPanel("todo"),
    },
    {
      id: "action:settings",
      section: "actions",
      label: t("palette.openSettings"),
      hint: "Ctrl+,",
      run: () => {
        app.view = "settings";
        app.mobileTab = "settings";
      },
    },
  );

  for (const project of app.sortedProjects) {
    commands.push({
      id: `project:${project.id}`,
      section: "projects",
      label: projectDisplayName(project),
      hint: project.cwd,
      run: () => {
        app.selectedProjectId = project.id;
        app.view = "terminal";
      },
    });
  }

  return commands;
}
