/**
 * What a thread row looks like, decided once for both sidebar designs.
 *
 * The classic design draws a ring around the agent's logo; the signal design
 * puts a rail down the card's left edge and sweeps it while an agent works. They
 * disagree about where to paint and agree about everything else, so the mapping
 * from a thread's state to "which of six situations is this" lives here rather
 * than twice in two components' `$derived` blocks.
 *
 * No runes and no Svelte import: this is a pure function over what the row knows,
 * which is what makes the six cases testable without mounting a sidebar.
 */

import type { ThreadStatus } from "$lib/types";

/**
 * The six situations a row can be in.
 *
 * `finished` and `sleeping` are deliberately separate. A thread that just ended
 * is news and gets the bright end of the rail; one that ended a while ago and
 * had its PTY reaped is furniture, and furniture that still claims to be news is
 * how a sidebar stops meaning anything.
 */
export type ThreadVisualState =
  | "working"
  | "waiting"
  | "finished"
  | "ready"
  | "sleeping"
  | "failed";

/** Which of the palette's four status colours the row is painted in. */
export type ThreadTone = "warning" | "success" | "danger" | "awake" | "neutral";

export interface ThreadVisual {
  state: ThreadVisualState;
  tone: ThreadTone;
}

export interface ThreadVisualInput {
  /** What the dot should say, so `visibleStatus()` output rather than the row. */
  status: ThreadStatus;
  /** The thread was put to sleep by the idle timer rather than by its own exit. */
  asleep: boolean;
  /** Keep-awake, and a live PTY for it to keep. */
  keepAwake: boolean;
}

export const TONE_COLOR: Record<ThreadTone, string> = {
  warning: "var(--color-warning)",
  success: "var(--color-success)",
  danger: "var(--color-danger)",
  awake: "var(--color-awake)",
  neutral: "var(--color-border-strong)",
};

/**
 * Keep-awake tints what the thread *is*, never what it is *doing*.
 *
 * The violet says "this one will still be here later", which is a statement
 * about a parked thread. An agent that is mid-turn or blocked on an answer has
 * something more urgent to say, and repainting those amber states violet would
 * cost the one colour that means "look at me now" for a setting the user
 * already knows they made.
 */
export function threadVisual(input: ThreadVisualInput): ThreadVisual {
  const { status, asleep, keepAwake } = input;
  switch (status) {
    case "running":
      return { state: "working", tone: "warning" };
    case "waiting":
      return { state: "waiting", tone: "warning" };
    case "exited":
    case "error":
      return { state: "failed", tone: "danger" };
    // Every way of being asleep is grey, including the two that ended cleanly.
    // They used to be green, which put a finished thread and a dormant one in
    // the same colour with nothing between them; the state already says
    // "asleep", and a second signal that agrees with it says nothing twice.
    case "stopped":
      return { state: "sleeping", tone: "neutral" };
    case "done":
      return asleep
        ? { state: "sleeping", tone: "neutral" }
        : { state: "finished", tone: keepAwake ? "awake" : "success" };
    case "ready":
      return { state: "ready", tone: keepAwake ? "awake" : "success" };
    default:
      // `idle` is a row with no process behind it, which after a restart is
      // every row: they are asleep in the sense that matters here. Grey rather
      // than green, because a thread that ended in a previous session left no
      // word on how it ended and green would be a guess.
      return { state: "sleeping", tone: "neutral" };
  }
}

/**
 * The mark that stands where the agent's logo stands when the logos are off.
 *
 * Total on purpose. Its predecessor answered for two states out of six and left
 * the other four with nothing to draw, so turning the logos off emptied the
 * glyph rather than changing it: a row that was working showed a bare circle,
 * which reads as a component that failed to render.
 *
 * The names are shapes rather than characters, so the one place that picks a
 * glyph for each is the component that draws it.
 */
export type ThreadToken = "dot" | "ask" | "check" | "ring" | "zed" | "bang";

const TOKENS: Record<ThreadVisualState, ThreadToken> = {
  working: "dot",
  waiting: "ask",
  finished: "check",
  ready: "ring",
  sleeping: "zed",
  failed: "bang",
};

export function stateTokenOf(state: ThreadVisualState): ThreadToken {
  return TOKENS[state];
}
