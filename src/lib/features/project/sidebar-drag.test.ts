import { describe, expect, it } from "vitest";
import {
  DRAG_SHIFT_TRANSITION,
  DRAG_THRESHOLD_PX,
  dragShiftStyle,
  dropIntent,
  hasBecomeADrag,
  reordered,
  reorderedAmongVisible,
  rowShift,
  sideFromRect,
  slotIndexAt,
  type HoverFacts,
  type RowSnapshot,
} from "./sidebar-drag";

/** Four rows of 40px, stacked from y=100. */
const ROWS: RowSnapshot[] = [
  { id: "a", top: 100, height: 40 },
  { id: "b", top: 140, height: 40 },
  { id: "c", top: 180, height: 40 },
  { id: "d", top: 220, height: 40 },
];

describe("becoming a drag", () => {
  it("a press that barely moves is still a click", () => {
    // The sidebar is full of clicks — selecting a project, activating a thread,
    // hitting a menu. A threshold of zero turns every one of them into a drag
    // that commits an order nobody asked to change.
    expect(hasBecomeADrag({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(false);
  });

  it("measures the distance, not either axis on its own", () => {
    // Diagonal: 3-4-5. Under a per-axis check this would not have started, and
    // dragging a row at an angle would do nothing until it went far enough
    // sideways.
    expect(DRAG_THRESHOLD_PX).toBe(5);
    expect(hasBecomeADrag({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(true);
    expect(hasBecomeADrag({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
  });
});

describe("where the card lands", () => {
  it("counts the list without the row being carried", () => {
    // Dragging "a" out and holding it over what is now the first gap. The
    // indices are into the list as it will be, which is what the caller
    // splices into: an index into the list as it is would insert one row late
    // for everything below the source.
    expect(slotIndexAt(ROWS, "a", 110)).toBe(0);
    expect(slotIndexAt(ROWS, "a", 165)).toBe(1);
    expect(slotIndexAt(ROWS, "a", 205)).toBe(2);
    expect(slotIndexAt(ROWS, "a", 900)).toBe(3);
  });

  it("switches at the midpoint of a row, not its edge", () => {
    // "b" removed leaves a(100), c(180), d(220). The boundary between slot 0
    // and slot 1 is a's midpoint at 120, not its bottom at 140.
    expect(slotIndexAt(ROWS, "b", 119)).toBe(0);
    expect(slotIndexAt(ROWS, "b", 121)).toBe(1);
  });

  it("answers nothing rather than zero when there is nothing to decide", () => {
    // Zero would be a real position — the top of the list — so a stale snapshot
    // or an empty one would silently reorder rather than doing nothing.
    expect(slotIndexAt([], "a", 100)).toBeNull();
    expect(slotIndexAt(ROWS, "not-here", 100)).toBeNull();
    // A list of one is the exception: removing the dragged row leaves nowhere
    // else to go, and the answer is a position rather than a refusal.
    expect(slotIndexAt([ROWS[0]], "a", 999)).toBe(0);
  });
});

describe("how the other rows get out of the way", () => {
  it("leaves the carried row alone", () => {
    expect(rowShift(1, 1, 3, 40)).toBe(0);
  });

  it("closes the gap behind the source and opens one at the slot", () => {
    // Carrying "a" (index 0) down to slot 2. Rows below it have already moved
    // up by one height; the two at or past the slot then move back down.
    const shift = (idx: number) => rowShift(idx, 0, 2, 40);
    expect(shift(1)).toBe(-40); // b: closed the gap, still before the slot
    expect(shift(2)).toBe(-40); // c: same
    expect(shift(3)).toBe(0); // d: closed the gap and opened one, net zero
  });

  it("moves rows down when the card is carried upward", () => {
    // Carrying "d" (index 3) to the top. Nothing is below the source, so
    // nothing closes a gap; everything at or after slot 0 opens one.
    const shift = (idx: number) => rowShift(idx, 3, 0, 40);
    expect(shift(0)).toBe(40);
    expect(shift(1)).toBe(40);
    expect(shift(2)).toBe(40);
  });

  it("a drop back where it started moves nothing", () => {
    for (let i = 0; i < 4; i++) expect(rowShift(i, 1, 1, 40)).toBe(0);
  });
});

describe("when a row actually gets a transform", () => {
  it("writes nothing at rest, even for a zero shift", () => {
    // translateY(0) plus the 180ms transition is a compositor layer per row.
    // Scratch's fade used to sit on the same card, so those layers were evicted
    // after the card sat off screen, and scrolling back drew the hatch first.
    expect(dragShiftStyle(false, false, 0, "none")).toEqual({});
    expect(dragShiftStyle(false, false, 40, "none")).toEqual({});
  });

  it("keeps the carried row on its source transform with no transition", () => {
    expect(dragShiftStyle(true, true, 0, "none")).toEqual({
      transform: "none",
      transition: "none",
    });
    expect(
      dragShiftStyle(true, true, 0, "translate(0px, 12px) scale(1.015)"),
    ).toEqual({
      transform: "translate(0px, 12px) scale(1.015)",
      transition: "none",
    });
  });

  it("slides a neighbour only while a drag is on", () => {
    expect(dragShiftStyle(true, false, -40, "none")).toEqual({
      transform: "translateY(-40px)",
      transition: DRAG_SHIFT_TRANSITION,
    });
    expect(dragShiftStyle(true, false, 0, "none")).toEqual({
      transition: DRAG_SHIFT_TRANSITION,
    });
  });
});

describe("which edge of a pane", () => {
  const rect = { x: 0, y: 0, w: 800, h: 200 };

  it("compares the fraction of each axis, not the pixels", () => {
    // 100px from the left of an 800-wide pane is 12.5% across; 60px from the
    // top of a 200-tall one is 30% down. In pixels the top edge is nearer, and
    // a pane this shape would split horizontally almost everywhere, which is
    // not what somebody dragging into its left third means.
    expect(sideFromRect(rect, 100, 60)).toBe("left");
    expect(sideFromRect(rect, 700, 60)).toBe("right");
  });

  it("takes the near half of whichever axis wins", () => {
    expect(sideFromRect(rect, 400, 10)).toBe("top");
    expect(sideFromRect(rect, 400, 190)).toBe("bottom");
  });
});

describe("what letting go means", () => {
  const facts = (over: Partial<HoverFacts>): HoverFacts => ({
    inSidebar: true,
    overOwnList: false,
    overOwnHeader: false,
    overProjectId: null,
    isLiveProject: () => true,
    ...over,
  });

  it("over its own list is a reorder, never a move into itself", () => {
    expect(dropIntent("p1", facts({ overOwnList: true, overProjectId: "p1" }))).toEqual({
      kind: "reorder",
    });
    expect(dropIntent("p1", facts({ overOwnHeader: true, overProjectId: "p1" }))).toEqual({
      kind: "reorder",
    });
  });

  it("over another project hands the thread to it", () => {
    expect(dropIntent("p1", facts({ overProjectId: "p2" }))).toEqual({
      kind: "give",
      projectId: "p2",
    });
  });

  it("will not give a thread to a project the sidebar is not showing", () => {
    // Archived rows are only on screen while the archive list is open. Dropping
    // onto one would move a live thread into a project the user has put away,
    // where nothing would show it again.
    expect(
      dropIntent("p1", facts({ overProjectId: "archived", isLiveProject: () => false })),
    ).toEqual({ kind: "none" });
  });

  it("outside the sidebar decides nothing, and leaves it to the panes", () => {
    // The pane viewport has already had its say by here; answering `give` or
    // `reorder` on top of that is how a thread ends up both split into a pane
    // and reordered in a list it was dragged out of.
    expect(
      dropIntent("p1", facts({ inSidebar: false, overOwnList: true, overProjectId: "p2" })),
    ).toEqual({ kind: "none" });
  });
});

describe("committing the order", () => {
  it("moves the id and leaves everything else in place", () => {
    expect(reordered(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(reordered(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("clamps a slot past the end instead of leaving a hole", () => {
    expect(reordered(["a", "b"], "a", 99)).toEqual(["b", "a"]);
  });

  it("refuses a list the id is not in", () => {
    // The alternative is worse than doing nothing: the caller saves what comes
    // back, so an unchanged list would be fine and a list with the dragged row
    // quietly missing would not.
    expect(reordered(["a", "b"], "zzz", 0)).toBeNull();
  });
});

describe("committing the order of a list that hides rows", () => {
  /// The bug this exists for: the slot counts drawn rows, and "p" is pinned into
  /// its own section, so applying the slot to the saved list landed the drop one
  /// place too high. Dropping "a" between "b" and "c" has to end up between them.
  it("counts the slot in drawn rows, not in saved ones", () => {
    expect(
      reorderedAmongVisible(["a", "p", "b", "c"], ["a", "b", "c"], "a", 1),
    ).toEqual(["p", "b", "a", "c"]);
    // What it used to do with the same numbers, and what the sidebar drew.
    expect(reordered(["a", "p", "b", "c"], "a", 1)).toEqual(["p", "a", "b", "c"]);
  });

  it("keeps a hidden row where it was", () => {
    // A filed thread has a place in the order and comes back to it. Saving only
    // what is on screen would drop it to the end of the list on its way back.
    expect(
      reorderedAmongVisible(["a", "b", "f", "c"], ["a", "b", "c"], "a", 2),
    ).toEqual(["b", "f", "c", "a"]);
  });

  it("lands past the last drawn row, not past the last saved one", () => {
    expect(
      reorderedAmongVisible(["a", "b", "c", "f"], ["a", "b", "c"], "a", 2),
    ).toEqual(["b", "c", "a", "f"]);
  });

  it("changes nothing when the dragged row is the only one drawn", () => {
    expect(reorderedAmongVisible(["p", "a"], ["a"], "a", 0)).toEqual(["p", "a"]);
  });

  it("refuses when the two lists disagree about what exists", () => {
    expect(reorderedAmongVisible(["a", "b"], ["a", "b"], "zzz", 0)).toBeNull();
    expect(reorderedAmongVisible(["a", "b"], ["a", "ghost"], "a", 1)).toBeNull();
  });
});
