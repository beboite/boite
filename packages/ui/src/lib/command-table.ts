// Owns command labels and actions shared by the palette and keyboard settings.
import type { KeybindingCommand } from '@boite/contracts';
import { archiveThread, reopenLastArchived } from './archive';
import { lastAnswer } from './message-display';
import { sidebarRows } from './sidebar-rows.svelte';
import { workspace } from './workspace.svelte';
import { projectView } from './project-view.svelte';
import { openTour } from './onboarding.svelte';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';
import { setTheme } from './theme';

type CommandDefinition = {
  id: string;
  label?: () => string;
  ownerOnly?: boolean;
  run?: (store: Store, inShell: boolean) => void;
};

// Labels are read when requested so a language change reaches keyboard settings.
export const commandTable: readonly CommandDefinition[] = [
  { id: 'new-thread', label: () => strings.palette.newThread, run: (store) => {
    const selected = workspace.view === 'recent' ? projectView.selected(workspace.machines.flatMap(machine => machine.store.projects.filter(project => !project.archived).map(project => ({ machine, project })))) : undefined;
    // Always a new, empty draft: the project's other drafts stay where they are.
    if (selected) void workspace.select(selected.machine.store, undefined, selected.project.id, { fresh: true });
    else { store.showChat(); store.startDraft(undefined, { fresh: true }); }
  } },
  { id: 'palette', label: () => strings.keyboard.commands.palette, run: (store) => { store.paletteOpen = !store.paletteOpen; } },
  { id: 'sidebar', label: () => strings.palette.sidebar, run: (store) => { store.toggleSidebar(); } },
  { id: 'panel', label: () => strings.palette.panel, run: (store) => { store.showChat(); store.togglePanel(); } },
  { id: 'browser', label: () => strings.keyboard.commands.browser },
  { id: 'changes', label: () => strings.keyboard.commands.changes, ownerOnly: true, run: (store) => { store.showChat(); store.panel.toggleKind('changes'); } },
  { id: 'files', label: () => strings.keyboard.commands.files, ownerOnly: true, run: (store) => { store.showChat(); store.panel.toggleKind('files'); } },
  { id: 'tasks', label: () => strings.keyboard.commands.tasks, ownerOnly: true, run: (store) => { store.showChat(); store.panel.toggleKind('tasks'); } },
  { id: 'close-surface', label: () => strings.keyboard.commands.closeSurface },
  { id: 'settings', label: () => strings.palette.settings, run: (store) => { store.showSettings(); } },
  { id: 'stash', label: () => strings.keyboard.commands.stash },
  { id: 'send-and-draft', label: () => strings.keyboard.commands.sendAndDraft },
  { id: 'add-project', label: () => strings.palette.addProject, ownerOnly: true, run: (store) => { store.projectPickerOpen = true; } },
  { id: 'pin', label: () => strings.keyboard.commands.pin, run: (store) => { const open = store.openThread; if (open) void store.pin(open.id, !open.pinned); } },
  { id: 'rename', label: () => strings.palette.rename, run: (store) => { store.showChat(); store.renameRequested = true; } },
  { id: 'retitle', label: () => strings.palette.retitle, run: (store) => { const open = store.openThread; if (open) void store.retitle(open.id); } },
  { id: 'trace', label: () => strings.palette.trace, ownerOnly: true, run: (store) => { store.showChat(); store.panel.toggleKind('trace'); } },
  { id: 'appearance', label: () => strings.palette.appearance, run: (store) => { store.showSettings('appearance'); } },
  { id: 'providers', label: () => strings.palette.providers, ownerOnly: true, run: (store) => { store.showSettings('accounts'); } },
  { id: 'pair', label: () => strings.palette.pair, ownerOnly: true, run: (store) => { store.showSettings('machines', 'machines'); void store.addDevice(); } },
  { id: 'theme-dark', label: () => strings.palette.themeDark, run: () => { setTheme('dark'); } },
  { id: 'theme-light', label: () => strings.palette.themeLight, run: () => { setTheme('light'); } },
  { id: 'theme-system', label: () => strings.palette.themeSystem, run: () => { setTheme('system'); } },
  { id: 'archive', label: () => strings.palette.archive, run: (store) => { const open = store.openThread; if (open) void archiveThread(store, open.id); } },
  { id: 'import-session', label: () => strings.palette.importSession, ownerOnly: true, run: (store) => {
    // The open thread's project, else the draft's, else the first one.
    const projectId = store.openThread?.projectId ?? store.draft?.projectId ?? store.projects[0]?.id;
    if (projectId !== undefined) void store.openImports(projectId);
  } },
  { id: 'terminal', label: () => strings.palette.terminal, ownerOnly: true, run: (store) => { const open = store.openThread; if (open) { store.showChat(); store.toggleTerminal(); } } },
  { id: 'terminal-new', label: () => strings.keyboard.commands.terminalNew, ownerOnly: true },
  { id: 'terminal-split', label: () => strings.keyboard.commands.terminalSplit, ownerOnly: true },
  { id: 'terminal-split-vertical', label: () => strings.keyboard.commands.terminalSplitVertical, ownerOnly: true },
  { id: 'terminal-close', label: () => strings.keyboard.commands.terminalClose, ownerOnly: true },
  { id: 'terminal-find', label: () => strings.keyboard.commands.terminalFind, ownerOnly: true },
  { id: 'terminal-history', label: () => strings.keyboard.commands.terminalHistory, ownerOnly: true },
  { id: 'terminal-previous-command', label: () => strings.keyboard.commands.terminalPreviousCommand, ownerOnly: true },
  { id: 'terminal-next-command', label: () => strings.keyboard.commands.terminalNextCommand, ownerOnly: true },
  { id: 'reopen-thread', label: () => strings.keyboard.commands.reopenThread, run: (store) => { void reopenLastArchived(store); } },
  { id: 'copy-answer', label: () => strings.keyboard.commands.copyAnswer, run: (store) => { const open = store.openThread; if (open) { const text = lastAnswer(open.messages); if (text) void store.copy(text); } } },
  { id: 'find', label: () => strings.keyboard.commands.find, run: (store) => { const open = store.openThread; if (open) { store.showChat(); store.findOpen = true; store.findRequest += 1; } } },
  { id: 'subagents', run: (store) => { store.showChat(); store.panel.toggleKind('agents'); } },
  { id: 'task-manager', run: (store) => { store.showSettings('task-manager'); } },
  { id: 'archived', run: (store) => { store.showSettings('general', 'archived'); } },
  { id: 'tour', run: (store) => { store.showChat(); openTour(); } },
];
const commandsById = new Map(commandTable.map(command => [command.id, command]));
const threadCommands = new Set(Array.from({ length: 9 }, (_, index) => `thread-${index + 1}`));

/** The label of every command a chord can reach. */
export function commandLabel(id: KeybindingCommand): string {
  return commandsById.get(id)?.label?.() ?? fill(strings.keyboard.commands.thread, { n: id.slice('thread-'.length) });
}

/** Palette and shortcut callers keep the same command entry point. */
export function runCommand(store: Store, id: string, inShell: boolean): void {
  const command = commandsById.get(id);
  // Hidden owner rows can still be reached by a shortcut.
  if (!store.owner && command?.ownerOnly) return;
  if (threadCommands.has(id)) {
    const target = sidebarRows.list[Number(id.slice('thread-'.length)) - 1];
    if (target) { store.showChat(); void workspace.select(target.store, target.threadId); }
    return;
  }
  command?.run?.(store, inShell);
}
