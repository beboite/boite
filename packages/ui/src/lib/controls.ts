/*
 * The buttons a device may put away, grouped by where they sit, with the
 * name and icon the Appearance page draws for each. The ids and what a device
 * hides live in `work-prefs.svelte.ts`; this file only says what they look like.
 */
import type { Component } from 'svelte';
import { ChartPie, Folder, FolderPlus, Gauge, GitBranch, SquareTerminal, UsersRound } from '@lucide/svelte';
import { contextMenu } from './context-menu.svelte';
import type { SurfaceKind } from './right-panel.svelte';
import { strings } from './strings';
import type { Store } from './store.svelte';
import { CARDS, kindName } from './surface-labels';
import { work, type ControlId } from './work-prefs.svelte';

export type ControlGroupId = 'header' | 'sidebar' | 'panel';

export interface ControlEntry {
  id: ControlId;
  label: string;
  /** A lucide icon, or the surface whose own icon the row draws. */
  icon: Component<{ size?: number; strokeWidth?: number }> | null;
  kind?: SurfaceKind;
}

export interface ControlGroup {
  id: ControlGroupId;
  label: string;
  entries: ControlEntry[];
}

/** The settings section the page draws the buttons in; a button's right click leads there. */
export const CONTROLS_SECTION = 'buttons';

/**
 * Every group in the order the page draws them. The terminal and Add a
 * project are the owner's: a paired device never has them to hide.
 */
export function controlGroups(owner: boolean): ControlGroup[] {
  const header: ControlEntry[] = [
    { id: 'header.project', label: strings.controls.project, icon: Folder },
    { id: 'header.branch', label: strings.controls.branch, icon: GitBranch },
    { id: 'header.context', label: strings.controls.context, icon: ChartPie },
    { id: 'header.agents', label: strings.delegation.heading, icon: UsersRound },
    ...(owner ? [{ id: 'header.terminal' as const, label: strings.terminal.title, icon: SquareTerminal }] : [])
  ];
  const sidebar: ControlEntry[] = [
    { id: 'sidebar.limits', label: strings.usage.limits, icon: Gauge },
    ...(owner ? [{ id: 'sidebar.add-project' as const, label: strings.sidebar.addProject, icon: FolderPlus }] : [])
  ];
  const panel: ControlEntry[] = CARDS.map((card) => ({ id: `panel.${card.kind}` as ControlId, label: kindName(card.kind), icon: null, kind: card.kind }));
  return [
    { id: 'header', label: strings.controls.header, entries: header },
    { id: 'sidebar', label: strings.controls.sidebar, entries: sidebar },
    { id: 'panel', label: strings.controls.panel, entries: panel }
  ];
}

/** A button's right click: put it away here, or go and choose among all of them. */
export function controlMenu(event: MouseEvent, store: Store, id: ControlId): void {
  contextMenu.open(
    event,
    [
      { id: 'hide', label: strings.controls.hide },
      { id: 'customize', label: strings.controls.customize }
    ],
    (action) => {
      if (action === 'hide') work.show(id, false);
      else store.showSettings('appearance', CONTROLS_SECTION);
    }
  );
}
