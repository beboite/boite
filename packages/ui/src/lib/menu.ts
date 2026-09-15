/** One row of a popover or context menu. A row with `separator` draws a rule and nothing else. */
export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
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
