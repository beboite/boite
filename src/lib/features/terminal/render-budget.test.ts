import { describe, expect, it } from "vitest";
import { createRenderBudget } from "./render-budget";

type Log = string[];

function pane(budget: ReturnType<typeof createRenderBudget>, name: string, log: Log) {
  return budget.claim({
    grant: () => log.push(`+${name}`),
    revoke: () => log.push(`-${name}`),
  });
}

describe("the render budget", () => {
  it("grants nothing to a pane that is not on screen", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    pane(budget, "a", log);
    expect(log).toEqual([]);
    expect(budget.outstanding()).toBe(0);
  });

  it("grants every wanter while there is room", () => {
    const log: Log = [];
    const budget = createRenderBudget(2);
    pane(budget, "a", log).want(true);
    pane(budget, "b", log).want(true);
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
    expect(log).toEqual(["-a", "+c"]);
    expect(budget.outstanding()).toBe(2);
  });

  it("revokes before it grants, so the count never exceeds the budget", () => {
    const budget = createRenderBudget(1);
    const log: Log = [];
    pane(budget, "a", log).want(true);
    pane(budget, "b", log).want(true);
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
    expect(log).toEqual(["-a", "+b"]);
    log.length = 0;
    b.want(false);
    expect(log).toEqual(["-b", "+a"]);
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

  it("ignores a disposed slot still being driven by a late effect", () => {
    const log: Log = [];
    const budget = createRenderBudget(1);
    const a = pane(budget, "a", log);
    a.dispose();
    a.want(true);
    a.touch();
    expect(log).toEqual([]);
    expect(a.granted()).toBe(false);
  });
});
