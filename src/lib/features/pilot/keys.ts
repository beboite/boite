/**
 * What a keystroke in the composer means, with no DOM in it.
 *
 * Split out of the component for the same reason `reduce.ts` is split out of
 * the store: this is the half worth a test, and a component test would have to
 * mount a textarea and synthesise events to reach it.
 *
 * The rule the shape enforces: **sending during a turn is not queuing.** The
 * backend steers a turn already in flight (`pilot.turn.start` on a busy thread
 * is a steering message), so the composer has one verb for both cases and never
 * holds a line back. A composer that queued would be a second idea of what the
 * conversation is, kept in a place the timeline cannot see.
 */

import type { PilotStatus } from "./types";

/** What the pane should do with a keystroke. */
export type ComposerAction =
  /** Nothing: let the textarea handle it. A newline, a character, a caret move. */
  | { kind: "insert" }
  /** Send what is typed. `steering` says a turn was already running. */
  | { kind: "send"; steering: boolean }
  /** Escape on a running turn. */
  | { kind: "interrupt" };

/** The parts of a keyboard event this decision reads. */
export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  /** True while an IME is composing, where the browser reports it. */
  composing?: boolean;
}

/**
 * Enter sends, Shift+Enter inserts, Escape interrupts a running turn.
 *
 * An empty box never sends: Enter on nothing would open an empty turn the
 * driver has to answer. Escape on an idle thread does nothing here so the
 * overlay stack keeps it, which is what closes a menu opened over the pane.
 *
 * A slash command is not a case: `/name` is text like any other and goes to the
 * driver untouched, which is what "slash commands declared at init pass through"
 * means in `docs/pilot.md`.
 */
export function composerAction(
  event: ComposerKey,
  text: string,
  status: PilotStatus,
): ComposerAction {
  if (event.composing) return { kind: "insert" };
  if (event.key === "Escape") {
    return status === "busy" ? { kind: "interrupt" } : { kind: "insert" };
  }
  if (event.key !== "Enter" || event.shiftKey) return { kind: "insert" };
  if (text.trim().length === 0) return { kind: "insert" };
  return { kind: "send", steering: status === "busy" };
}
