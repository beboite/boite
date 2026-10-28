/*
 * Boite's application commands and dispatcher for the palette and shortcuts.
 * The composer's slash menu keeps its prompt controls in composer-menus.ts.
 */

import type { KeybindingCommand } from '@boite/contracts';
import { experimentOn } from './experiments.svelte';
import type { PaletteItem } from './palette';
import { strings } from './strings';
import type { Store } from './store.svelte';

/** What marks an agent's own command apart from Boite's in a mixed list. */
export const AGENT_PREFIX = 'agent:';

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
 * ones that need an open thread are only there while one is. A phone, which
 * leaves Providers to the desktop (`desktopSettings`), is offered no way to it.
 */
export function appCommands(store: Store, phone: boolean): PaletteItem[] {
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
    items.push(row('find', strings.palette.find, 'search text ctrl+f'));
    items.push(row('copy-answer', strings.keyboard.commands.copyAnswer, 'clipboard reply response'));
    items.push(row('panel', strings.palette.panel, 'browser surface'));
    // Following subagents and workflow runs is open to a paired device.
    items.push({ id: 'subagents', kind: 'command', label: strings.palette.subagents, keywords: 'subagent agent team workflow steps graph plan run' });
    // A paired device reads the working tree (`DEVICE_METHODS`), never the
    // project's todos, the trace or a terminal.
    items.push(row('changes', strings.palette.changes, 'git diff working tree'));
    items.push(row('files', strings.palette.files, 'tree directory explorer'));
    if (store.owner) {
      items.push(row('tasks', strings.palette.tasks, 'todo goal loop'));
      // A button put away in Appearance stays here: the palette is the way back to it.
      items.push(row('trace', strings.palette.trace, 'processes load'));
      items.push(row('terminal', strings.palette.terminal, 'shell console powershell cmd bash'));
    }
  }
  items.push(row('sidebar', strings.palette.sidebar));
  items.push(row('settings', strings.palette.settings, 'preferences'));
  items.push(row('appearance', strings.palette.appearance, 'theme material buttons toolbar'));
  items.push({ id: 'task-manager', kind: 'command', label: strings.taskManager.title, keywords: 'cpu gpu ram memory disk storage network processes usage' });
  // The one way back to an archived thread: no chord, so written like the tour.
  items.push({ id: 'archived', kind: 'command', label: strings.settings.archived.heading, keywords: 'archive restore unarchive old hidden' });
  items.push(row('reopen-thread', strings.keyboard.commands.reopenThread, 'undo closed restore unarchive last'));
  if (store.owner) {
    if (!phone) items.push(row('providers', strings.palette.providers, 'accounts login install'));
    items.push(row('pair', strings.palette.pair, 'phone link devices'));
  }
  // The tour again. It is no chord's command, so it is written here rather
  // than through `row`, which reads the keyboard table.
  items.push({ id: 'tour', kind: 'command', label: strings.onboarding.replay, keywords: 'onboarding guide tour intro' });
  items.push(row('theme-dark', strings.palette.themeDark));
  items.push(row('theme-light', strings.palette.themeLight));
  items.push(row('theme-system', strings.palette.themeSystem));
  if (open) items.push(row('archive', strings.palette.archive, 'close remove'));
  return items;
}

export { commandLabel, runCommand } from './command-table';
