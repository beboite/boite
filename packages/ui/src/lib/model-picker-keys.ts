import type { Closing } from './closing.svelte';

/**
 * What the model picker's keyboard reads and moves. The arrows cross the whole
 * popover (tiles, account chips, model rows, the legacy submenu), so every
 * query starts from the picker's root or its open menu.
 */
export interface PickerKeyState {
  popover: Closing;
  legacy: Closing;
  root(): HTMLElement | undefined;
  menu(): HTMLElement | undefined;
  searchBox(): HTMLInputElement | undefined;
  legacyOpen(): boolean;
  searchable(): boolean;
  modelQuery(): string;
  clearQuery(): void;
}

/** The picker's keydown handler, shared by its trigger, its popover and its legacy submenu. */
export function pickerKeydown(picker: PickerKeyState): (event: KeyboardEvent) => void {
  function focusable(): HTMLElement[] {
    return Array.from(activeMenu()?.querySelectorAll<HTMLElement>('[data-row]:not(:disabled)') ?? []);
  }

  function activeMenu(): HTMLElement | null {
    return picker.legacyOpen() ? picker.root()?.querySelector<HTMLElement>('[data-testid=picker-legacy-menu]') ?? null : picker.menu() ?? null;
  }

  /** The model rows alone: what the arrows walk once the search field has the focus. */
  function modelRows(): HTMLElement[] {
    return Array.from(activeMenu()?.querySelectorAll<HTMLElement>('.models [data-row]:not(:disabled)') ?? []);
  }

  function handleEscape(event: KeyboardEvent) {
    event.stopPropagation();
    if (picker.legacyOpen()) {
      picker.legacy.hide();
      picker.root()?.querySelector<HTMLElement>('[data-testid=picker-legacy]')?.focus();
      return;
    }
    // The query goes first: closing on it would throw away what was just typed.
    if (picker.searchable() && picker.modelQuery() !== '') {
      picker.clearQuery();
      picker.searchBox()?.focus();
      return;
    }
    picker.popover.hide();
  }

  function handleLegacyNavigation(event: KeyboardEvent, active: HTMLElement | null): boolean {
    if (event.key === 'ArrowRight' && active?.dataset.testid === 'picker-legacy') {
      event.preventDefault();
      picker.legacy.show();
      queueMicrotask(() => picker.root()?.querySelector<HTMLElement>('[data-testid=picker-legacy-menu] [data-model]')?.focus());
      return true;
    }
    if (event.key === 'ArrowLeft' && active?.closest('[data-testid=picker-legacy-menu]')) {
      event.preventDefault();
      picker.legacy.hide();
      picker.root()?.querySelector<HTMLElement>('[data-testid=picker-legacy]')?.focus();
      return true;
    }
    return false;
  }

  function handleModelSearch(event: KeyboardEvent, active: HTMLElement | null): boolean {
    if (picker.legacyOpen()) return false;
    const searchBox = picker.searchBox();
    if (!picker.searchable() || (active !== searchBox && !active?.hasAttribute('data-model'))) return false;
    if (event.key === 'Enter') {
      // A focused row is activated by the browser too; taking the default keeps it to one pick.
      event.preventDefault();
      const row = active === searchBox ? modelRows()[0] : active;
      row?.click();
      return true;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    event.preventDefault();
    const list = modelRows();
    const here = active === searchBox || !active ? -1 : list.indexOf(active);
    if (event.key === 'ArrowDown') list[Math.min(here + 1, list.length - 1)]?.focus();
    else if (here <= 0) searchBox?.focus();
    else list[here - 1]?.focus();
    return true;
  }

  function handleAccountNavigation(event: KeyboardEvent, active: HTMLElement | null): boolean {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
    // The account chips are a segmented control: the arrows walk them.
    const root = picker.root();
    const chips = root ? Array.from(root.querySelectorAll<HTMLElement>('.popover [data-seat]:not(:disabled)')) : [];
    const here = active ? chips.indexOf(active) : -1;
    if (here === -1) return false;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    chips[(here + step + chips.length) % chips.length]?.focus();
    return true;
  }

  function handleRowNavigation(event: KeyboardEvent, active: HTMLElement | null) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = focusable();
    if (list.length === 0) return;
    event.preventDefault();
    const index = active ? list.indexOf(active) : -1;
    const next = event.key === 'ArrowDown' ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
    list[next]?.focus();
  }

  return function onkeydown(event: KeyboardEvent) {
    if (!picker.popover.open) return;
    const active = document.activeElement as HTMLElement | null;
    if (event.key === 'Escape') return handleEscape(event);
    if (handleLegacyNavigation(event, active)) return;
    if (handleModelSearch(event, active)) return;
    if (handleAccountNavigation(event, active)) return;
    handleRowNavigation(event, active);
  };
}
