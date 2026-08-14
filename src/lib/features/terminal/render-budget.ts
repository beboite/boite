/**
 * Who gets a GPU context, and who waits for one.
 *
 * A browser keeps a small number of WebGL contexts alive at once, sixteen in
 * Chromium, which is the webview on two platforms of three. Boite mounts one
 * terminal per activated thread and never unmounts it while the thread lives,
 * so the seventeenth thread opened in a session takes a context away from the
 * oldest one. What the oldest one does about it today is nothing: the addon
 * disposes itself on context loss and that pane spends the rest of the session
 * on the DOM renderer, silently, including once it is back on screen.
 *
 * So contexts are handed out here rather than taken. A pane asks while it is on
 * screen and stops asking when it is hidden, and when more panes ask than the
 * budget allows, the least recently shown holder is revoked to pay for the new
 * one. Nothing is lost in a revocation: the renderer is an addon over a buffer
 * xterm owns, so a revoked pane keeps its scrollback, its selection, its
 * process and its size, and draws with the DOM renderer until it is granted
 * again.
 *
 * Asking to stop is not the same as giving back, though, and that distinction is
 * the whole difference between a budget and a churn machine. A hidden pane that
 * dropped its context every time would pay a teardown and a rebuild for nothing
 * while the window is nowhere near the ceiling, and `visible` is per group here,
 * so one group switch flips a dozen panes at once. A holder that stopped wanting
 * therefore keeps what it has and simply moves to the front of the eviction
 * queue: it only loses the context when a wanter actually needs the slot.
 *
 * The bookkeeping is deliberately free of anything WebGL: it hands out slots
 * and calls back, which is what makes the eviction order testable without a
 * canvas.
 */

/**
 * Twelve, not sixteen. Contexts are not freed the instant an addon disposes,
 * the browser reclaims them on its own schedule, so a budget sitting on the
 * hard limit still loses the race whenever a pane is granted in the same frame
 * another was revoked. Four spare is the margin, and a window showing more than
 * twelve terminals at once has cells too small to read anyway.
 */
export const DEFAULT_RENDER_BUDGET = 12;

/**
 * How long a revocation waits for the rest of its batch.
 *
 * A pane is shown or hidden with its whole group, as a burst of independent
 * effects in no guaranteed order, so the queue mid-burst says things that are
 * true for a microtask: every pane of the arriving group asking before a single
 * one of the leaving group has stopped. Revoking on that reading and granting it
 * back a tick later is a GPU context destroyed and rebuilt per pane for a
 * decision that never held. Only the destructive edge waits; a grant that costs
 * nobody anything is immediate, because there is nothing for it to wait for.
 */
export const REVOKE_SETTLE_MS = 150;

export type RenderSlotHandlers = {
  /**
   * The slot is yours. Called at most once per grant, never re-entrantly, and
   * never while the slot already holds a context.
   */
  grant(): void;
  /** Give it back. Called only on a slot that was granted. */
  revoke(): void;
};

export type RenderSlot = {
  /**
   * Whether this pane wants a context at all. A hidden pane wants none, which
   * puts it at the head of the eviction queue rather than taking anything from
   * it: off screen is what makes a pane cheap to evict, not what evicts it.
   */
  want(on: boolean): void;
  /**
   * Move to the front of the queue without changing what is wanted. Focus does
   * this, so the pane the user is typing in is the last one an eviction takes.
   */
  touch(): void;
  granted(): boolean;
  /**
   * Leaves the budget for good, freeing whatever it held for the others. No
   * `revoke` comes back for it: a caller disposing its slot is tearing its own
   * renderer down anyway, so releasing the context is its job, not ours.
   */
  dispose(): void;
};

export type RenderBudget = {
  claim(handlers: RenderSlotHandlers): RenderSlot;
  /** How many contexts are out. Diagnostics and tests. */
  outstanding(): number;
};

type Entry = {
  handlers: RenderSlotHandlers;
  wants: boolean;
  granted: boolean;
  /** Monotonic; the highest is the most recently shown or focused. */
  seq: number;
  live: boolean;
};

export function createRenderBudget(
  limit = DEFAULT_RENDER_BUDGET,
  settleMs = REVOKE_SETTLE_MS,
): RenderBudget {
  const entries = new Set<Entry>();
  let seq = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Who should be holding a context once the dust settles: the panes asking,
   * most recently shown first, and then the panes still holding one without
   * asking any more, in the same order.
   *
   * That second half is what keeps a hidden pane's context in place. It sits
   * below every wanter, so it is spent the moment one needs a slot and never
   * before, and among themselves the oldest hidden pane is spent first.
   */
  function plan(): Set<Entry> {
    const recentFirst = (a: Entry, b: Entry) => b.seq - a.seq;
    const wanters = [...entries].filter((e) => e.live && e.wants).sort(recentFirst);
    const idle = [...entries].filter((e) => e.live && e.granted && !e.wants).sort(recentFirst);
    return new Set([...wanters, ...idle].slice(0, limit));
  }

  function apply(keep: Set<Entry>) {
    // Revoke before granting, in that order and in two passes: a grant issued
    // while the context it is paid for is still held is exactly the race the
    // budget exists to avoid.
    for (const entry of entries) {
      if (entry.granted && !keep.has(entry)) {
        entry.granted = false;
        entry.handlers.revoke();
      }
    }
    for (const entry of keep) {
      if (!entry.granted && entry.wants) {
        entry.granted = true;
        entry.handlers.grant();
      }
    }
  }

  function rebalance() {
    const keep = plan();
    const pressure = [...entries].some((e) => e.granted && !keep.has(e));
    if (!pressure) {
      // Room for everyone, so there is nothing to take and nothing to wait for.
      // Any pass that was waiting to take something is answering a queue this
      // one has already replaced.
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      apply(keep);
      return;
    }
    // Over the ceiling, so every grant this plan is holding is paid for by one
    // of its revocations and none of it can be split off and done now. Let the
    // burst finish and plan again from what it settled on, which more often than
    // not is a queue that needs no revocation at all.
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      apply(plan());
    }, settleMs);
  }

  return {
    claim(handlers) {
      const entry: Entry = {
        handlers,
        wants: false,
        granted: false,
        seq: ++seq,
        live: true,
      };
      entries.add(entry);
      return {
        want(on) {
          if (!entry.live || entry.wants === on) return;
          entry.wants = on;
          if (on) entry.seq = ++seq;
          rebalance();
        },
        touch() {
          if (!entry.live) return;
          entry.seq = ++seq;
          // Only the order changed, so nothing moves unless the budget is full
          // and someone below the line is now above it.
          if (entry.wants) rebalance();
        },
        granted: () => entry.granted,
        dispose() {
          if (!entry.live) return;
          entry.live = false;
          entries.delete(entry);
          // No revoke callback: the caller is tearing its terminal down, and
          // calling back into a disposed component is how a dispose handler
          // ends up running twice.
          entry.granted = false;
          rebalance();
        },
      };
    },
    outstanding: () => [...entries].filter((e) => e.granted).length,
  };
}

/** The one every terminal shares. */
export const terminalRenderBudget = createRenderBudget();
