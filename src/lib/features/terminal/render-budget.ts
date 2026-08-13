/**
 * Who gets a GPU context, and who waits for one.
 *
 * A browser keeps a small number of WebGL contexts alive at once — sixteen in
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
 * The bookkeeping is deliberately free of anything WebGL: it hands out slots
 * and calls back, which is what makes the eviction order testable without a
 * canvas.
 */

/**
 * Twelve, not sixteen. Contexts are not freed the instant an addon disposes —
 * the browser reclaims them on its own schedule — so a budget sitting on the
 * hard limit still loses the race whenever a pane is granted in the same frame
 * another was revoked. Four spare is the margin, and a window showing more than
 * twelve terminals at once has cells too small to read anyway.
 */
export const DEFAULT_RENDER_BUDGET = 12;

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
   * Whether this pane wants a context at all. A hidden pane wants none, and
   * that is the whole point of the budget: panes off screen pay nothing.
   */
  want(on: boolean): void;
  /**
   * Move to the front of the queue without changing what is wanted. Focus does
   * this, so the pane the user is typing in is the last one an eviction takes.
   */
  touch(): void;
  granted(): boolean;
  /** Leaves the budget for good, returning whatever it held. */
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

export function createRenderBudget(limit = DEFAULT_RENDER_BUDGET): RenderBudget {
  const entries = new Set<Entry>();
  let seq = 0;

  function rebalance() {
    const wanters = [...entries].filter((e) => e.live && e.wants);
    wanters.sort((a, b) => b.seq - a.seq);
    const keep = new Set(wanters.slice(0, limit));

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
      if (!entry.granted) {
        entry.granted = true;
        entry.handlers.grant();
      }
    }
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
