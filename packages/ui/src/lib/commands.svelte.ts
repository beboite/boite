/*
 * Boite's own commands: one list and one dispatcher, shared by the command
 * palette and the composer's slash menu. The palette draws them by their
 * label, the slash menu by their id as `/name` with the label under it, so a
 * command is written once and both entries stay in step.
 */

import type { PaletteItem } from './palette';
import { strings } from './strings';
import type { Store } from './store.svelte';
import { setTheme } from './theme';

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
 * ones that need an open thread are only there while one is.
 */
export function appCommands(store: Store, inShell: boolean): PaletteItem[] {
  void inShell;
  const open = store.openThread;
  const items: PaletteItem[] = [];
  if (store.projects.length > 0) items.push({ id: 'new-thread', kind: 'command', label: strings.palette.newThread, hint: 'Ctrl+N', keywords: 'draft start' });
  items.push({ id: 'add-project', kind: 'command', label: strings.palette.addProject, keywords: 'folder open' });
  if (open) {
    items.push({ id: 'pin', kind: 'command', label: open.pinned ? strings.palette.unpin : strings.palette.pin, keywords: 'favourite top' });
    items.push({ id: 'rename', kind: 'command', label: strings.palette.rename, keywords: 'title' });
    items.push({ id: 'panel', kind: 'command', label: strings.palette.panel, hint: 'Ctrl+Alt+B', keywords: 'browser surface' });
    items.push({ id: 'trace', kind: 'command', label: strings.palette.trace, keywords: 'processes load' });
  }
  items.push({ id: 'sidebar', kind: 'command', label: strings.palette.sidebar, hint: 'Ctrl+B' });
  items.push({ id: 'settings', kind: 'command', label: strings.palette.settings, hint: 'Ctrl+,', keywords: 'preferences' });
  items.push({ id: 'appearance', kind: 'command', label: strings.palette.appearance, keywords: 'theme material' });
  items.push({ id: 'providers', kind: 'command', label: strings.palette.providers, keywords: 'accounts login install' });
  items.push({ id: 'pair', kind: 'command', label: strings.palette.pair, keywords: 'phone link devices' });
  items.push({ id: 'theme-dark', kind: 'command', label: strings.palette.themeDark });
  items.push({ id: 'theme-light', kind: 'command', label: strings.palette.themeLight });
  items.push({ id: 'theme-system', kind: 'command', label: strings.palette.themeSystem });
  if (open) items.push({ id: 'archive', kind: 'command', label: strings.palette.archive, keywords: 'close remove' });
  return items;
}

/**
 * Runs one of them. `inShell` picks the native folder dialog over the settings
 * page for `add-project`: a browser has no folder picker to offer.
 */
export function runCommand(store: Store, id: string, inShell: boolean): void {
  const open = store.openThread;
  switch (id) {
    case 'new-thread': store.showChat(); store.startDraft(); break;
    case 'add-project':
      if (inShell) void store.pickProject();
      else store.showSettings('general');
      break;
    case 'pin': if (open) void store.pin(open.id, !open.pinned); break;
    case 'rename': store.showChat(); store.renameRequested = true; break;
    case 'panel': store.showChat(); store.panel.toggle(); break;
    case 'trace': store.showChat(); if (!store.panelOpen || store.panel.activeSurfaceId !== 'trace') store.togglePanel(); break;
    case 'sidebar': store.toggleSidebar(); break;
    case 'settings': store.showSettings(); break;
    case 'appearance': store.showSettings('appearance'); break;
    case 'providers': store.showSettings('accounts'); break;
    case 'pair': store.showSettings('general'); break;
    case 'theme-dark': setTheme('dark'); break;
    case 'theme-light': setTheme('light'); break;
    case 'theme-system': setTheme('system'); break;
    case 'archive': if (open) void store.archive(open.id); break;
    default: break;
  }
}
