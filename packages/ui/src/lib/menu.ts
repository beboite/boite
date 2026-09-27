import type { Component } from 'svelte';

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
  status?: { tone: 'success' | 'warning' | 'danger'; label: string };
  active?: boolean;
  hideActiveMark?: boolean;
  icon?: 'settings';
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function separator(id = 'sep'): MenuItem {
  return { id, label: '', separator: true };
}
