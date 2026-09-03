/**
 * What a thread row looks like, decided once for both sidebar designs.
 *
 * The classic design draws a ring around the agent's logo; the glow design lights
 * the whole card and sweeps it while an agent works. They disagree about where to
 * paint and agree about everything else, so the mapping from a thread's state to
 * "which of six situations is this" lives here rather than twice in two
 * components' `$derived` blocks.
 *
 * No runes and no Svelte import: this is a pure function over what the row knows,
 * which is what makes the six cases testable without mounting a sidebar.
 */

import type { ThreadStatus } from "$lib/types";

/**
 * The seven situations a row can be in.
 *
 * `finished` and `sleeping` are deliberately separate, and they can hold the same
 * tone. A thread that just ended is news and gets the bright end of the scale;
 * one that ended a while ago and had its PTY reaped keeps the colour and loses
 * the brightness, because furniture that still claims to be news is how a sidebar
 * stops meaning anything.
 *
 * `cold` is the end of that same argument: a row nothing has happened to draws
 * nothing. It used to be `sleeping`, and since a restart left every row saying
 * `idle`, every launch opened on a column of sleeping badges — a state that
 * describes all of them describes none of them. Sleeping is a thread that was on
 * and got cut off, and only the rows that carry a run say it now.
 */
export type ThreadVisualState =
  | "working"
  | "waiting"
  | "finished"
  | "ready"
  | "sleeping"
  | "cold"
  | "failed";

/** Which of the palette's status colours the row is painted in. */
export type ThreadTone =
  | "warning"
  | "success"
  | "danger"
  | "awake"
  | "dormant"
  | "parked";

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

/**
 * The two quiet tones are both dark greens rather than a grey, and the quiet end
 * of the scale is the whole reason.
 *
 * Grey is what this app has nothing to say in, and it was carrying things that
 * are not nothing: a thread the idle timer put to sleep, one that was killed,
 * one that came back from a restart. On a sidebar where five rows in twelve are
 * asleep, a grey column reads as rows that failed to draw rather than as rows at
 * rest. The hue says "this is a thread"; the darkness is what keeps it from
 * competing with the one that actually finished, which keeps the bright success
 * green.
 *
 * `dormant` and `parked` are one step apart in that darkness, and the step is
 * what this run of the app watched happen: only `dormant` is a sleep Boite saw
 * the timer take.
 */
export const TONE_COLOR: Record<ThreadTone, string> = {
  warning: "var(--color-warning)",
  success: "var(--color-success)",
  danger: "var(--color-danger)",
  awake: "var(--color-awake)",
  dormant: "var(--color-dormant)",
  parked: "var(--color-parked)",
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
    // Killed rather than ended. Nothing was completed, so it does not get the
    // green that means it was. Which of the two dark greens it gets is whether
    // the idle timer is what stopped it: `asleep` is in memory and never
    // persisted, so it is true of a sleep this run of the app watched happen and
    // false of every other way a row ends up parked.
    case "stopped":
      return { state: "sleeping", tone: asleep ? "dormant" : "parked" };
    // A thread that finished and was then parked by the idle timer keeps the
    // colour it earned. What it loses is the brightness: `sleeping` is graded at
    // half of `finished`, so the row still answers "this one is done" to a
    // glance that arrives an hour late without competing with the one that
    // finished a minute ago. The tone alone is the difference between a sleeping
    // thread that did its work and one that was cut off.
    case "done":
      return asleep
        ? { state: "sleeping", tone: keepAwake ? "awake" : "success" }
        : { state: "finished", tone: keepAwake ? "awake" : "success" };
    case "ready":
      return { state: "ready", tone: keepAwake ? "awake" : "success" };
    default:
      // `idle` is a row nothing has run behind, and that is now a statement
      // rather than the absence of one: the table keeps a mark for a thread that
      // was launched, so a row still saying `idle` at boot is one nobody has
      // ever started. It draws nothing — no colour, no badge, the agent's logo
      // and its name. It used to draw as sleeping, on the reasoning that a
      // restart leaves nothing behind, which was true of the storage and not of
      // the thread: the sidebar opened with every row wearing a `z`, including
      // the twenty that had never been run, and a badge every row wears is one
      // no row is read for.
      return { state: "cold", tone: "parked" };
  }
}

