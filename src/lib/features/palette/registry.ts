import { app } from "$lib/app/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { projectDisplayName } from "$lib/shared/project-label";
import {
  closeThreadWithConfirm,
  launchBlankTerminalHere,
  launchShortcut,
  launchTargetProjectId,
  restoreLastClosedThread,
} from "$lib/features/thread/api";
import { openProjectDashboard } from "$lib/features/project/dashboard";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { t } from "$lib/i18n/index.svelte";
import type { MessageKey } from "$lib/i18n/index.svelte";
import { isDeviceMacOS } from "$lib/storage/platform.svelte";
import { anchorPaneId, openPane } from "$lib/features/panes/open";
import { paneStore } from "$lib/features/panes/store.svelte";
import { classifyBrowserUrl } from "$lib/features/browser/url";
import { notifications } from "$lib/features/notifications/store.svelte";
import { openTodo } from "$lib/features/todo/open";
import { contentRowId } from "./content";
import type { WorkspaceHit } from "$lib/backend/types";
import type { PaneContent, PanelKind } from "$lib/features/panes/types";
import type { IconKey } from "$lib/types";

import type { PaletteSection } from "./sections";

export type { PaletteSection, ScoredSection } from "./sections";
export { SECTION_BIAS, SECTION_ORDER, SECTION_TITLE_KEYS } from "./sections";

export interface PaletteCommand {
  id: string;
  section: PaletteSection;
  /** Text straight out of user data: a thread title, a project name. Never translated. */
  label?: string;
  /**
   * A short word for what a row *is*, when its label does not say.
   *
   * Only content hits carry one: an excerpt is a sentence out of a todo, a
   * journal entry or a terminal, and which of the three it came from decides
   * where activating it lands.
   */
  badgeKey?: MessageKey;
  /**
   * A fixed command's wording, held as a dictionary key and resolved at render.
   * Resolving here instead would freeze the language the list was built in.
   */
  labelKey?: MessageKey;
  labelParams?: Record<string, string | number>;
  /** Data shown beside the label: a cwd, a command line, a project name. */
  hint?: string;
  /**
   * Keyboard chord in the controller's own notation ("mod+t"). Rendered per
   * platform, since `mod` is the Command key on macOS and Ctrl everywhere else.
   */
  chord?: string;
  /** Same glyph the sidebar row wears, so a thread is recognised before it is read. */
  icon?: { key: IconKey; color: string | null };
  run: () => void | Promise<unknown>;
}

// The chord the keyboard controller actually listens for, spelled the way the
// platform spells it. A mac user reading "Ctrl+T" is being told about a chord
// that does nothing there.
export function formatChord(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const label = key.length === 1 ? key.toUpperCase() : key;
  if (isDeviceMacOS) {
    let out = "";
    if (parts.includes("alt")) out += "⌥";
    if (parts.includes("shift")) out += "⇧";
    if (parts.includes("mod")) out += "⌘";
    return out + label;
  }
  const chunks: string[] = [];
  if (parts.includes("mod")) chunks.push("Ctrl");
  if (parts.includes("shift")) chunks.push("Shift");
  if (parts.includes("alt")) chunks.push("Alt");
  chunks.push(label);
  return chunks.join("+");
}

/** Both resolvers run at render time, never while the list is being built. */
export function commandLabel(c: PaletteCommand): string {
  return c.labelKey ? t(c.labelKey, c.labelParams) : (c.label ?? "");
}

export function commandHint(c: PaletteCommand): string | null {
  if (c.chord) return formatChord(c.chord);
  return c.hint ?? null;
}

export function goToThread(threadId: string, projectId: string) {
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
          ? `${projectDisplayName(project)} / ${thread.label}`
          : projectDisplayName(project),
        icon: { key: thread.iconKey, color: thread.iconColor ?? null },
        run: () => goToThread(thread.id, project.id),
      });
    }
  }

  commands.push({
    id: "action:new-terminal",
    section: "actions",
    labelKey: "welcome.newTerminal",
    chord: "mod+t",
    run: () => launchBlankTerminalHere(),
  });
  for (const shortcut of settings.state.shortcuts) {
    commands.push({
      id: `action:shortcut:${shortcut.id}`,
      section: "actions",
      labelKey: "palette.launchShortcut",
      labelParams: { label: shortcut.label },
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
    labelKey: "palette.restoreThread",
    chord: "mod+shift+t",
    run: () => restoreLastClosedThread(),
  });
  if (app.activeThreadId) {
    const id = app.activeThreadId;
    commands.push({
      id: "action:close-thread",
      section: "actions",
      labelKey: "palette.closeActiveThread",
      chord: "mod+w",
      run: () => closeThreadWithConfirm(id),
    });
  }
  // The mobile layout draws no sidebar at all, so toggling the device-persisted
  // flag there is a silent no-op on something nothing renders.
  const mobile = settings.state.mobileLayout;
  if (!mobile) {
    commands.push({
      id: "action:toggle-sidebar",
      section: "actions",
      labelKey: "titlebar.toggleSidebar",
      chord: "mod+b",
      run: () => settings.toggleSidebar(),
    });
  }
  commands.push({
    id: "action:settings",
    section: "actions",
    labelKey: "palette.openSettings",
    chord: "mod+,",
    run: () => {
      app.view = "settings";
      app.mobileTab = "settings";
    },
  });

  if (app.currentProjectId) {
    commands.push({
      id: "action:project-dashboard",
      section: "actions",
      labelKey: "palette.openDashboard",
      run: () => openProjectDashboard(app.currentProjectId as string),
    });
  }

  // Git, files and the todo list show in the docked column, which is where they
  // live: asking for git from the palette means the same thing as clicking git
  // in the titlebar, and neither should rearrange the panes. The info-box
  // experiment replaces that column, so while it is on these commands would
  // set a panel nothing renders — same reason the titlebar hides its buttons.
  if (!settings.state.experimentInfoBox) {
    const panelCommands: [PanelKind, MessageKey][] = [
      ["git", "panes.openGit"],
      ["explorer", "panes.openExplorer"],
      ["todo", "panes.openTodo"],
    ];
    for (const [kind, labelKey] of panelCommands) {
      commands.push({
        id: `panel:${kind}`,
        section: "panes",
        labelKey,
        run: () => settings.setRightPanel(app.currentProjectId, kind),
      });
    }
  }

  // Panes. Until now the only way to make one was to drag a thread row onto a
  // live terminal, which is a gesture nobody finds by accident and the reason
  // the split went unused. These are the same call the titlebar's context menu
  // and the agent's MCP verb make.
  const paneCommands: [string, MessageKey, PaneContent][] = [
    ["dashboard", "panes.openDashboard", { kind: "dashboard" }],
    ["editor", "panes.openEditor", { kind: "editor" }],
  ];
  for (const [id, labelKey, content] of paneCommands) {
    commands.push({
      id: `pane:${id}`,
      section: "panes",
      labelKey,
      run: () => {
        openPane(content);
      },
    });
  }
  // Panes carry no chrome of their own any more, so this is where a pane that
  // is not one of the three panels — a dashboard, an editor, a page an agent
  // opened — is closed from.
  commands.push({
    id: "pane:close",
    section: "panes",
    labelKey: "panes.closePane",
    run: () => {
      // The focused pane of the group on screen, which is what `anchorPaneId`
      // answers: a pane opens beside it, and this closes it.
      const paneId = anchorPaneId();
      if (paneId) paneStore.closePane(paneId);
    },
  });
  commands.push({
    id: "pane:browser",
    section: "panes",
    labelKey: "panes.openBrowser",
    run: () => {
      // A prompt rather than a form: the palette closes on run, and a second
      // modal to type a URL into is a lot of machinery for the rare case. The
      // common case is an agent calling this with the URL already known.
      const typed = window.prompt(t("panes.browserPrompt"), "http://localhost:");
      if (!typed?.trim()) return;
      // Typing it is consent to see the page, not consent to frame the app's
      // own origin inside itself. Same rules the agent's request goes through.
      const target = classifyBrowserUrl(typed);
      if (!target.ok) {
        notifications.error(t(`browser.refuse.${target.reason}`));
        return;
      }
      openPane({ kind: "browser", url: target.url });
    },
  });

  for (const project of app.sortedProjects) {
    commands.push({
      id: `project:${project.id}`,
      section: "projects",
      label: projectDisplayName(project),
      hint: project.cwd,
      // The project's own page, the same place clicking its sidebar row lands.
      // This used to drop you on the terminal view, which showed whatever thread
      // happened to be active and made the two doors disagree.
      run: () => openProjectDashboard(project.id),
    });
  }

  return commands;
}

/**
 * What the workspace wrote down, as rows the palette can draw.
 *
 * Built per answer rather than per open, and separately from everything above:
 * these arrive from `search.query` after a round trip, and the command list must
 * never be waiting on one.
 *
 * A hit whose project or thread is gone is dropped. Its excerpt is still true
 * and there is nowhere to go from it, and a row that does nothing when it is
 * activated is worse in a palette than a row that is not there.
 */
export function buildContentCommands(hits: WorkspaceHit[]): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  for (const [index, hit] of hits.entries()) {
    const row = contentRow(hit, index);
    if (row) commands.push(row);
  }
  return commands;
}

function contentRow(hit: WorkspaceHit, index: number): PaletteCommand | null {
  const id = contentRowId(hit, index);
  if (hit.kind === "transcript") {
    // A transcript names its thread and nothing else: the file is on disk under
    // the thread id, and which project that belongs to is the row's to say.
    const thread = app.threadById(hit.refId);
    if (!thread) return null;
    const project = app.projectById(thread.projectId);
    return {
      id,
      section: "content",
      badgeKey: "palette.hitTerminal",
      label: hit.excerpt,
      hint: project
        ? `${thread.title ?? thread.label} / ${projectDisplayName(project)}`
        : (thread.title ?? thread.label),
      icon: { key: thread.iconKey, color: thread.iconColor ?? null },
      run: () => goToThread(thread.id, thread.projectId),
    };
  }

  const project = app.projectById(hit.projectId);
  if (!project) return null;
  if (hit.kind === "todo") {
    return {
      id,
      section: "content",
      badgeKey: "palette.hitTodo",
      label: hit.excerpt,
      hint: projectDisplayName(project),
      run: () => openTodo(project.id, hit.refId),
    };
  }
  // A journal entry. Nothing in Boite draws one, so the closest true
  // destination is the project it happened in; inventing a viewer for it is a
  // feature, not a navigation target.
  return {
    id,
    section: "content",
    badgeKey: "palette.hitJournal",
    label: hit.excerpt,
    hint: projectDisplayName(project),
    run: () => openProjectDashboard(project.id),
  };
}
