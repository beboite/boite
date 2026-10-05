import type { Component } from 'svelte';
import type { Project } from '@boite/contracts';
import type { Store } from './store.svelte';

/** One row of a popover or context menu. A row with `separator` draws a rule and nothing else. */
export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  /** Said on hover rather than printed under the label. */
  title?: string;
  /** A lucide icon drawn before the label, in the live colour when `live`. */
  glyph?: Component<{ size?: number; strokeWidth?: number }>;
  live?: boolean;
  /** A project's tile before the label: its logo, its stack's mark or its initial, read through the Store that owns it. */
  projectTile?: { project: Project; store: Store };
  status?: { tone: 'success' | 'warning' | 'danger'; label: string };
  active?: boolean;
  /** A persistent toggle, announced and drawn as a checkbox in the context menu. */
  checked?: boolean;
  /** With `checked`: one choice of several, marked with a check instead of a switch. */
  radio?: boolean;
  hideActiveMark?: boolean;
  icon?: 'settings';
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function separator(id = 'sep'): MenuItem {
  return { id, label: '', separator: true };
}
