/*
 * The buttons a device may put away, grouped by where they sit, with the
 * name and icon the Appearance page draws for each. Only that page reads it,
 * so its icons and the panel's names load with the settings, not the app.
 */
import type { Component } from 'svelte';
import { ChartPie, Folder, FolderPlus, Gauge, GitBranch, SquareTerminal } from '@lucide/svelte';
import type { SurfaceKind } from './right-panel.svelte';
import { strings } from './strings';
import { experimentOn } from './experiments.svelte';
import { CARDS, kindName } from './surface-labels';
import type { ControlId } from './work-prefs.svelte';

export type ControlGroupId = 'header' | 'composer' | 'sidebar' | 'panel';

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

/**
 * Every group in the order the page draws them. The terminal and Add a
 * project are the owner's: a paired device never has them to hide.
 */
export function controlGroups(owner: boolean): ControlGroup[] {
  const header: ControlEntry[] = [
    { id: 'header.project', label: strings.controls.project, icon: Folder },
    { id: 'header.branch', label: strings.controls.branch, icon: GitBranch },
    ...(owner ? [{ id: 'header.terminal' as const, label: strings.terminal.title, icon: SquareTerminal }] : [])
  ];
  const sidebar: ControlEntry[] = [
    { id: 'sidebar.limits', label: strings.usage.limits, icon: Gauge },
    ...(owner ? [{ id: 'sidebar.add-project' as const, label: strings.sidebar.addProject, icon: FolderPlus }] : [])
  ];
  const panel: ControlEntry[] = CARDS.filter((card) => card.kind !== 'device' || experimentOn('device-panel')).map((card) => ({ id: `panel.${card.kind}` as ControlId, label: kindName(card.kind), icon: null, kind: card.kind }));
  return [
    { id: 'header', label: strings.controls.header, entries: header },
    { id: 'composer', label: strings.controls.composer, entries: [
      { id: 'header.context', label: strings.controls.context, icon: ChartPie },
      { id: 'composer.worktree', label: strings.composer.worktree, icon: GitBranch }
    ] },
    { id: 'sidebar', label: strings.controls.sidebar, entries: sidebar },
    { id: 'panel', label: strings.controls.panel, entries: panel }
  ];
}
