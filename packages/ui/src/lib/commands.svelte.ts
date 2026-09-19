/*
 * Boite's own commands: one list and one dispatcher, shared by the command
 * palette and the composer's slash menu. The palette draws them by their
 * label, the slash menu by their id as `/name` with the label under it, so a
 * command is written once and both entries stay in step.
 */

import type { KeybindingCommand } from '@boite/contracts';
import { experimentOn } from './experiments.svelte';
import type { PaletteItem } from './palette';
import { strings } from './strings';
import type { Store } from './store.svelte';
import { setTheme } from './theme';

/** What marks an agent's own command apart from Boite's in a mixed list. */
export const AGENT_PREFIX = 'agent:';

/** The commands that end in a method only the owner may call. */
const OWNER_COMMANDS = new Set<string>([
  'add-project',
  'import-session',
  'trace',
  'changes',
  'files',
  'tasks',
  'providers',
  'pair'
]);

/** True while this row is a command the agent reported, not one of Boite's. */
export function isAgentCommand(item: PaletteItem): boolean {
  return item.id.startsWith(AGENT_PREFIX);
}

/** The word a `/name` row completes to, the leading slash off. */
export function slashName(item: PaletteItem): string {
  return item.label.startsWith('/') ? item.label.slice(1) : item.label;
}

/**
 * Every command Boite runs itself, in the order the palette shows them. The
 * ones that need an open thread are only there while one is.
 */
export function appCommands(store: Store, inShell: boolean): PaletteItem[] {
  void inShell;
  const open = store.openThread;
  const items: PaletteItem[] = [];
  /** One row, its hint the chord the keyboard table holds for it, if any. */
  const row = (id: KeybindingCommand, label: string, keywords?: string): PaletteItem => {
    const hint = store.keyLabel(id);
    return { id, kind: 'command', label, ...(hint === null ? {} : { hint }), ...(keywords === undefined ? {} : { keywords }) };
  };
  if (store.projects.length > 0) items.push(row('new-thread', strings.palette.newThread, 'draft start'));
  // Opening a folder, reading a transcript, listing processes and everything
  // Providers and pairing do are the owner's: `packages/core/src/access.ts`
  // refuses them to a paired device, so they are not offered to one.
  if (store.owner) items.push(row('add-project', strings.palette.addProject, 'folder open'));
  if (store.owner && store.projects.length > 0 && experimentOn('session-import')) items.push(row('import-session', strings.palette.importSession, 'transcript history resume'));
  if (open) {
    items.push(row('pin', open.pinned ? strings.palette.unpin : strings.palette.pin, 'favourite top'));
    items.push(row('rename', strings.palette.rename, 'title'));
    items.push(row('retitle', strings.palette.retitle, 'title agent name'));
    items.push(row('panel', strings.palette.panel, 'browser surface'));
    // The three read the working directory or the project's todos, which
    // `packages/core/src/access.ts` refuses to a paired device.
    if (store.owner) {
      items.push(row('changes', strings.palette.changes, 'git diff working tree'));
      items.push(row('files', strings.palette.files, 'tree directory explorer'));
      items.push(row('tasks', strings.palette.tasks, 'todo goal loop'));
      items.push(row('trace', strings.palette.trace, 'processes load'));
    }
  }
  items.push(row('sidebar', strings.palette.sidebar));
  items.push(row('settings', strings.palette.settings, 'preferences'));
  items.push(row('appearance', strings.palette.appearance, 'theme material'));
  if (store.owner) {
    items.push(row('providers', strings.palette.providers, 'accounts login install'));
    items.push(row('pair', strings.palette.pair, 'phone link devices'));
  }
  items.push(row('theme-dark', strings.palette.themeDark));
  items.push(row('theme-light', strings.palette.themeLight));
  items.push(row('theme-system', strings.palette.themeSystem));
  if (open) items.push(row('archive', strings.palette.archive, 'close remove'));
  return items;
}

/** The label of every command a chord can reach, the palette's words where it has them. */
export function commandLabel(id: KeybindingCommand): string {
  switch (id) {
    case 'new-thread': return strings.palette.newThread;
    case 'palette': return strings.keyboard.commands.palette;
    case 'sidebar': return strings.palette.sidebar;
    case 'panel': return strings.palette.panel;
    case 'browser': return strings.keyboard.commands.browser;
    case 'changes': return strings.keyboard.commands.changes;
    case 'files': return strings.keyboard.commands.files;
    case 'tasks': return strings.keyboard.commands.tasks;
    case 'close-surface': return strings.keyboard.commands.closeSurface;
    case 'settings': return strings.palette.settings;
    case 'stash': return strings.keyboard.commands.stash;
    case 'send-and-draft': return strings.keyboard.commands.sendAndDraft;
    case 'add-project': return strings.palette.addProject;
    case 'pin': return strings.keyboard.commands.pin;
    case 'rename': return strings.palette.rename;
    case 'retitle': return strings.palette.retitle;
    case 'trace': return strings.palette.trace;
    case 'appearance': return strings.palette.appearance;
    case 'providers': return strings.palette.providers;
    case 'pair': return strings.palette.pair;
    case 'theme-dark': return strings.palette.themeDark;
    case 'theme-light': return strings.palette.themeLight;
    case 'theme-system': return strings.palette.themeSystem;
    case 'archive': return strings.palette.archive;
    case 'import-session': return strings.palette.importSession;
  }
}

/**
 * Runs one of them. `inShell` picks the native folder dialog over the settings
 * page for `add-project`: a browser has no folder picker to offer.
 */
export function runCommand(store: Store, id: string, inShell: boolean): void {
  const open = store.openThread;
  // A chord reaches this without a row to hide, so the boundary is checked here
  // too: these five are the owner's, whatever key was pressed.
  if (!store.owner && OWNER_COMMANDS.has(id)) return;
  switch (id) {
    case 'new-thread': store.showChat(); store.startDraft(); break;
    case 'palette': store.paletteOpen = !store.paletteOpen; break;
    case 'add-project':
      store.projectPickerOpen = true;
      break;
    case 'pin': if (open) void store.pin(open.id, !open.pinned); break;
    case 'rename': store.showChat(); store.renameRequested = true; break;
    case 'retitle': if (open) void store.retitle(open.id); break;
    case 'panel': store.showChat(); store.panel.toggle(); break;
    case 'trace': store.showChat(); store.panel.toggleKind('trace'); break;
    case 'changes': store.showChat(); store.panel.toggleKind('changes'); break;
    case 'files': store.showChat(); store.panel.toggleKind('files'); break;
    case 'tasks': store.showChat(); store.panel.toggleKind('tasks'); break;
    case 'sidebar': store.toggleSidebar(); break;
    case 'settings': store.showSettings(); break;
    case 'appearance': store.showSettings('appearance'); break;
    case 'providers': store.showSettings('accounts'); break;
    case 'pair': store.showSettings('general'); break;
    case 'theme-dark': setTheme('dark'); break;
    case 'theme-light': setTheme('light'); break;
    case 'theme-system': setTheme('system'); break;
    case 'archive': if (open) void store.archive(open.id); break;
    case 'import-session': {
      // The open thread's project, else the draft's, else the first one.
      const projectId = open?.projectId ?? store.draft?.projectId ?? store.projects[0]?.id;
      if (projectId !== undefined) void store.openImports(projectId);
      break;
    }
    default: break;
  }
}
