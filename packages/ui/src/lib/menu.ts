/** One row of a popover menu. */
export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}
