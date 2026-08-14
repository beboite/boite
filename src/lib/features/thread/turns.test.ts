import { describe, expect, it } from "vitest";
import type { Checkpoint, CheckpointEdge } from "$lib/backend/types";
import { pairTurns, turnEdge } from "./turns";

function cp(index: number, edge: CheckpointEdge, extra: Partial<Checkpoint> = {}): Checkpoint {
  return {
    index,
    sha: `sha${index}`,
    edge,
    at: index * 1000,
    files: 0,
    additions: 0,
    deletions: 0,
    ...extra,
  };
}

describe("turnEdge", () => {
  it("opens on busy and closes on idle", () => {
    expect(turnEdge(false, "busy")).toBe("start");
    expect(turnEdge(true, "idle")).toBe("end");
  });

  it("does not open a turn that is already open, or close one that is not", () => {
    expect(turnEdge(true, "busy")).toBeNull();
    expect(turnEdge(false, "idle")).toBeNull();
  });

  it("treats a permission prompt and a launched shell as neither end", () => {
    for (const open of [true, false]) {
      expect(turnEdge(open, "waiting")).toBeNull();
      expect(turnEdge(open, "shell")).toBeNull();
      expect(turnEdge(open, null)).toBeNull();
      expect(turnEdge(open, undefined)).toBeNull();
    }
  });

  it("keeps one turn through a prompt in the middle of it", () => {
    let open = false;
    const edges: (string | null)[] = [];
    for (const state of ["busy", "waiting", "busy", "idle"] as const) {
      const edge = turnEdge(open, state);
      if (edge) open = edge === "start";
      edges.push(edge);
    }
    expect(edges).toEqual(["start", null, null, "end"]);
  });
});

describe("pairTurns", () => {
  it("pairs each start with the end that follows it", () => {
    const turns = pairTurns([
      cp(1, "start"),
      cp(2, "end", { files: 3, additions: 40, deletions: 2 }),
      cp(3, "start"),
      cp(4, "end", { files: 1 }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      id: 2,
      startSha: "sha1",
      endSha: "sha2",
      startedAt: 1000,
      endedAt: 2000,
      files: 3,
      additions: 40,
      deletions: 2,
    });
    expect(turns[1].id).toBe(4);
  });

  it("drops a turn still running rather than pairing it with the next one's end", () => {
    expect(pairTurns([cp(1, "start")])).toEqual([]);
    const turns = pairTurns([cp(1, "start"), cp(2, "start"), cp(3, "end")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].startSha).toBe("sha2");
  });

  it("ignores an end with nothing open in front of it", () => {
    expect(pairTurns([cp(1, "end"), cp(2, "end")])).toEqual([]);
    expect(pairTurns([])).toEqual([]);
  });

  it("does not read the net a revert left behind as the end of a turn", () => {
    // The user reverted while the agent was still working: the restore's own
    // checkpoint sits between the start and the real end, and closing the turn
    // on it would show the revert's tree as what the turn produced.
    const turns = pairTurns([cp(1, "start"), cp(2, "restore"), cp(3, "end", { files: 2 })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: 3, startSha: "sha1", endSha: "sha3", files: 2 });
    // And on its own it is not a row of its own either.
    expect(pairTurns([cp(1, "restore")])).toEqual([]);
  });
});
