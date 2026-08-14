import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderBudget, REVOKE_SETTLE_MS } from "./render-budget";

type Log = string[];

function pane(budget: ReturnType<typeof createRenderBudget>, name: string, log: Log) {
  return budget.claim({
    grant: () => log.push(`+${name}`),
    revoke: () => log.push(`-${name}`),
  });
}

/** Let the debounced revocation pass run. Grants under the limit never wait. */
function settle() {
  vi.advanceTimersByTime(REVOKE_SETTLE_MS);
}

describe("the render budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("grants nothing to a pane that is not on screen", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    pane(budget, "a", log);
    settle();
    expect(log).toEqual([]);
    expect(budget.outstanding()).toBe(0);
  });

  it("grants every wanter while there is room", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    pane(budget, "a", log).want(true);
    pane(budget, "b", log).want(true);
    // No revocation is involved, so neither grant waited for anything.
    expect(log).toEqual(["+a", "+b"]);
  });

  /**
   * The bug this whole module exists for: today the seventeenth pane takes the
   * first pane's context and nothing tells the first pane, which then draws on
   * the DOM renderer for the rest of the session. Here the eviction is the
   * budget's own, so the loser is told.
   */
  it("pays for a new pane by revoking the least recently shown one", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    pane(budget, "a", log).want(true);
    pane(budget, "b", log).want(true);
    log.length = 0;
    pane(budget, "c", log).want(true);
    settle();
    expect(log).toEqual(["-a", "+c"]);
    expect(budget.outstanding()).toBe(2);
  });

  it("revokes before it grants, so the count never exceeds the budget", () => {
    const budget = createRenderBudget(1);
    const log: Log = [];
    pane(budget, "a", log).want(true);
    pane(budget, "b", log).want(true);
    settle();
    expect(log).toEqual(["+a", "-a", "+b"]);
    expect(budget.outstanding()).toBe(1);
  });

  it("says the same thing twice without granting twice", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    const a = pane(budget, "a", log);
    a.want(true);
    a.want(true);
    expect(log).toEqual(["+a"]);
  });

  /**
   * The half a context-loss handler cannot do: give it back. A pane hidden and
   * shown again is granted without being remounted, so it keeps its scrollback.
   */
  it("gives a hidden pane's context back to the queue", () => {
    const log: Log = [];
    const budget = createRenderBudget(1);
    const a = pane(budget, "a", log);
    const b = pane(budget, "b", log);
    a.want(true);
    log.length = 0;
    b.want(true);
    settle();
    expect(log).toEqual(["-a", "+b"]);
    log.length = 0;
    b.want(false);
    settle();
    expect(log).toEqual(["-b", "+a"]);
  });

  /**
   * `visible` is per group, so hiding a pane on its own means nothing about
   * pressure: it is one of a dozen flipping together, and tearing its context
   * down while the window is nowhere near the ceiling buys exactly nothing and
   * costs a rebuild when it comes back.
   */
  it("leaves a hidden pane holding its context while nobody needs it", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    const a = pane(budget, "a", log);
    a.want(true);
    pane(budget, "b", log).want(true);
    log.length = 0;
    a.want(false);
    settle();
    expect(log).toEqual([]);
    expect(a.granted()).toBe(true);
    expect(budget.outstanding()).toBe(2);
  });

  it("costs a group flip nothing while both groups fit", () => {
    const log: Log = [];
    const budget = createRenderBudget(4);
    const a1 = pane(budget, "a1", log);
    const a2 = pane(budget, "a2", log);
    a1.want(true);
    a2.want(true);
    log.length = 0;
    // The arriving group asks before the leaving one has stopped, which is the
    // order the effects actually run in.
    pane(budget, "b1", log).want(true);
    pane(budget, "b2", log).want(true);
    a1.want(false);
    a2.want(false);
    settle();
    expect(log).toEqual(["+b1", "+b2"]);
    expect(budget.outstanding()).toBe(4);
  });

  /**
   * The same flip with the groups too big to coexist. Mid-burst there are four
   * wanters for two slots, and acting on that reading would revoke the arriving
   * panes it is about to grant. One pass, taken once the burst is over.
   */
  it("coalesces a flip that crosses the limit into a single pass", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    const a1 = pane(budget, "a1", log);
    const a2 = pane(budget, "a2", log);
    a1.want(true);
    a2.want(true);
    log.length = 0;
    const b1 = pane(budget, "b1", log);
    const b2 = pane(budget, "b2", log);
    b1.want(true);
    b2.want(true);
    a1.want(false);
    a2.want(false);
    expect(log).toEqual([]);
    settle();
    expect(log).toEqual(["-a1", "-a2", "+b2", "+b1"]);
    expect(budget.outstanding()).toBe(2);
  });

  it("spends the oldest hidden holder first", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    const a = pane(budget, "a", log);
    const b = pane(budget, "b", log);
    a.want(true);
    b.want(true);
    a.want(false);
    b.want(false);
    log.length = 0;
    pane(budget, "c", log).want(true);
    settle();
    // `a` was shown before `b`, so `b` keeps its context and `a` pays.
    expect(log).toEqual(["-a", "+c"]);
    expect(b.granted()).toBe(true);
  });

  /**
   * Focus reorders the queue without asking for anything, so the pane being
   * typed in is the last one an eviction takes.
   */
  it("puts a touched pane at the front of the eviction order", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    const a = pane(budget, "a", log);
    a.want(true);
    pane(budget, "b", log).want(true);
    a.touch();
    log.length = 0;
    pane(budget, "c", log).want(true);
    settle();
    expect(log).toEqual(["-b", "+c"]);
  });

  it("does not call back into a pane that disposed", () => {
    const log: Log = [];
    const budget = createRenderBudget(1);
    const a = pane(budget, "a", log);
    a.want(true);
    log.length = 0;
    a.dispose();
    expect(log).toEqual([]);
    expect(budget.outstanding()).toBe(0);
    // And the slot it held is available again.
    pane(budget, "b", log).want(true);
    expect(log).toEqual(["+b"]);
  });

  /**
   * A pane leaving frees a slot, which is the one thing that can make a pending
   * revocation pointless. It must be dropped, not fired late on a pane that has
   * been drawing happily since.
   */
  it("drops a pending revocation once the pressure is gone", () => {
    const log: Log = [];
    const budget = createRenderBudget(1);
    const a = pane(budget, "a", log);
    const b = pane(budget, "b", log);
    a.want(true);
    log.length = 0;
    b.want(true);
    b.dispose();
    settle();
    expect(log).toEqual([]);
    expect(a.granted()).toBe(true);
  });

  it("ignores a disposed slot still being driven by a late effect", () => {
    const log: Log = [];
    const budget = createRenderBudget(1);
    const a = pane(budget, "a", log);
    a.dispose();
    a.want(true);
    a.touch();
    settle();
    expect(log).toEqual([]);
    expect(a.granted()).toBe(false);
  });
});
