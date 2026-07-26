/**
 * Which layer currently owns the keyboard. Resolved top-down by priority, so
 * a binding declares where it applies instead of every handler re-deriving
 * "is a dialog open?" for itself.
 */
export type KeyScope = "modal" | "palette" | "settings" | "editor" | "app";

export interface ShortcutBinding {
  /** e.g. `mod+shift+t`, `escape`, `mod+digit1`, `mod+alt+arrowleft`. */
  combo: string;
  /** Scopes this binding is live in. `*` means every scope. */
  scopes: (KeyScope | "*")[];
  /**
   * Single-key bindings are skipped while an input, textarea or
   * contenteditable has focus unless this is set. Combos with a modifier
   * always run: the user cannot have meant to type Ctrl+W.
   */
  allowInInput?: boolean;
  /**
   * Returning `false` means "not handled here" — the dispatcher keeps looking
   * at later bindings instead of swallowing the event. Anything else counts
   * as handled and stops the event.
   */
  run: (event: KeyboardEvent) => boolean | void;
  /** Shown in the shortcuts help; also doubles as documentation. */
  description?: string;
}

export interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}
