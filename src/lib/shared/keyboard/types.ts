import type { KeyContext } from "./when";

export type { KeyContext };

/**
 * One rule, and the whole of what the user edits.
 *
 * `key` is the combo in the notation the dispatcher parses (`mod+shift+t`,
 * `escape`, `mod+digit1`). `command` is a stable id from the catalogue in
 * `commands.ts`, never a function: a rule crosses a socket and a database, so
 * nothing on it may be code. `when` is a boolean expression over context keys,
 * empty meaning "everywhere".
 */
export interface Keybinding {
  key: string;
  command: string;
  when?: string;
}

export interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * Returning `false` means "not handled here" — the dispatcher keeps looking at
 * the rules behind this one instead of swallowing the event. Anything else
 * counts as handled and stops the event.
 */
export type KeyCommandRun = (event: KeyboardEvent) => boolean | void;

/** A rule with its combo and its clause already turned into code. */
export interface CompiledRule {
  binding: Keybinding;
  combo: ParsedCombo;
  test: (ctx: KeyContext) => boolean;
  /** False when the clause did not parse. Kept so the editor can say so. */
  valid: boolean;
  allowInInput: boolean;
}
