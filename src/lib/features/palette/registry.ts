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

export type PaletteSection = "threads" | "actions" | "projects";

export interface PaletteCommand {
  id: string;
  section: PaletteSection;
  label: string;
  hint?: string;
  run: () => void | Promise<unknown>;
}

// Ranking bias when a query is active: a thread you can jump to beats an
// action of the same textual score, which beats selecting a project.
export const SECTION_BIAS: Record<PaletteSection, number> = {
  threads: 6,
  actions: 3,
  projects: 0,
};

export const SECTION_TITLES: Record<PaletteSection, string> = {
  threads: "Threads",
  actions: "Actions",
  projects: "Projects",
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
      commands.push({
        id: `thread:${thread.id}`,
        section: "threads",
        label: thread.label,
        hint: thread.title
          ? `${projectDisplayName(project)} — ${thread.title}`
          : projectDisplayName(project),
        run: () => goToThread(thread.id, project.id),
      });
    }
  }

  commands.push({
    id: "action:new-terminal",
    section: "actions",
    label: "New terminal",
    hint: "Ctrl+T",
    run: () => launchBlankTerminalHere(),
  });
  for (const shortcut of settings.state.shortcuts) {
    commands.push({
      id: `action:shortcut:${shortcut.id}`,
      section: "actions",
      label: `Launch ${shortcut.label}`,
      hint: shortcut.command,
      run: async () => {
        const projectId = await launchTargetProjectId();
        if (projectId) await launchShortcut(shortcut, projectId);
      },
    });
  }
  commands.push({
    id: "action:restore-thread",
    section: "actions",
    label: "Restore last closed thread",
    hint: "Ctrl+Shift+T",
    run: () => restoreLastClosedThread(),
  });
  if (app.activeThreadId) {
    const id = app.activeThreadId;
    commands.push({
      id: "action:close-thread",
      section: "actions",
      label: "Close active thread",
      hint: "Ctrl+W",
      run: () => closeThreadWithConfirm(id),
    });
  }
  commands.push(
    {
      id: "action:toggle-sidebar",
      section: "actions",
      label: "Toggle sidebar",
      hint: "Ctrl+B",
      run: () => settings.toggleSidebar(),
    },
    {
      id: "action:toggle-git",
      section: "actions",
      label: "Toggle git panel",
      run: () => settings.toggleRightPanel("git"),
    },
    {
      id: "action:toggle-explorer",
      section: "actions",
      label: "Toggle file explorer",
      run: () => settings.toggleRightPanel("explorer"),
    },
    {
      id: "action:toggle-todo",
      section: "actions",
      label: "Toggle todo notepad",
      run: () => settings.toggleRightPanel("todo"),
    },
    {
      id: "action:settings",
      section: "actions",
      label: "Open settings",
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
