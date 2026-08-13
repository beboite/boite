import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "$lib/types";
import {
  OFFERED_REPLIES,
  THREAD_REPLIES,
  needsAHuman,
  parseThreadLink,
  phaseOf,
  phraseKeys,
  replyLabel,
  threadLink,
  type AwarenessPhase,
  type ThreadReply,
} from "./awareness";

const ALL_STATUSES: ThreadStatus[] = [
  "idle",
  "running",
  "waiting",
  "ready",
  "done",
  "exited",
  "error",
  "stopped",
];

const ALL_PHASES: AwarenessPhase[] = [
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
];

describe("phaseOf", () => {
  it("answers for every status, with and without a process", () => {
    for (const status of ALL_STATUSES) {
      for (const hasProcess of [true, false]) {
        expect(ALL_PHASES).toContain(phaseOf(status, hasProcess));
      }
    }
  });

  it("puts every phase within reach", () => {
    const seen = new Set<AwarenessPhase>();
    for (const status of ALL_STATUSES) {
      for (const hasProcess of [true, false]) {
        for (const approval of [true, false]) {
          seen.add(phaseOf(status, hasProcess, approval));
        }
      }
    }
    expect([...seen].sort()).toEqual([...ALL_PHASES].sort());
  });

  it("reads a live status with no process behind it as stale", () => {
    // The thread nobody is looking at: a row still claiming a turn is in flight
    // when the process is gone. It must not reach a phone as work in progress.
    expect(phaseOf("running", false)).toBe("stale");
    expect(phaseOf("waiting", false)).toBe("stale");
    expect(phaseOf("running", true)).toBe("running");
    expect(phaseOf("waiting", true)).toBe("waiting_for_input");
  });

  it("lets an open approval outrank the staleness check", () => {
    // An approval is a row. It outlives the terminal that asked, and an agent
    // wired from a credentials file never had one.
    expect(phaseOf("waiting", false, true)).toBe("waiting_for_approval");
    expect(phaseOf("waiting", true, true)).toBe("waiting_for_approval");
  });

  it("tells a turn ending from a process ending", () => {
    expect(phaseOf("ready", true)).toBe("completed");
    expect(phaseOf("done", false)).toBe("completed");
    expect(phaseOf("exited", false)).toBe("failed");
    expect(phaseOf("error", false)).toBe("failed");
  });

  it("tells a thread that never ran from one that was slept", () => {
    expect(phaseOf("idle", false)).toBe("starting");
    expect(phaseOf("stopped", false)).toBe("stale");
  });

  it("only calls a person for the two blocking phases", () => {
    expect(ALL_PHASES.filter(needsAHuman)).toEqual([
      "waiting_for_approval",
      "waiting_for_input",
    ]);
  });

  it("has both message keys for every phase", () => {
    for (const phase of ALL_PHASES) {
      const keys = phraseKeys(phase);
      expect(keys.headline).toMatch(/^awareness\.headline\./);
      expect(keys.detail).toMatch(/^awareness\.detail\./);
    }
  });
});

describe("the reply vocabulary", () => {
  // The third corner of the pin. `boite_core::reply` asserts TOKENS against
  // awareness.json, awareness.ts reads the same file, and this says the union
  // has not drifted from it — without which a token added to the JSON alone
  // would silently widen to `string`.
  it("is the list the union names, in order", () => {
    const union: ThreadReply[] = [
      "yes",
      "no",
      "enter",
      "escape",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ];
    expect(THREAD_REPLIES).toEqual(union);
  });

  it("offers a subset of it, and labels everything it accepts", () => {
    for (const answer of OFFERED_REPLIES) {
      expect(THREAD_REPLIES).toContain(answer);
    }
    for (const answer of THREAD_REPLIES) {
      expect(replyLabel(answer)).toMatch(/^reply\./);
    }
  });
});

describe("a deep link", () => {
  it("round-trips a thread and its project", () => {
    const link = threadLink("t-1", "p-1");
    expect(link).toBe("/?thread=t-1&project=p-1");
    expect(parseThreadLink(link.slice(1))).toEqual({
      threadId: "t-1",
      projectId: "p-1",
    });
  });

  it("round-trips a thread on its own", () => {
    expect(threadLink("t-1", null)).toBe("/?thread=t-1");
    expect(parseThreadLink("?thread=t-1")).toEqual({
      threadId: "t-1",
      projectId: null,
    });
  });

  it("survives an id with punctuation in it, as the Rust writes it", () => {
    // boite_core::awareness::link percent-encodes the same way; a link that
    // round-trips here and not there would open the wrong thread or none.
    expect(threadLink("a b&c=d", "p/1")).toBe("/?thread=a+b%26c%3Dd&project=p%2F1");
    expect(parseThreadLink("?thread=a%20b%26c%3Dd&project=p%2F1")).toEqual({
      threadId: "a b&c=d",
      projectId: "p/1",
    });
  });

  it("answers null for anything that does not name a thread", () => {
    expect(parseThreadLink("")).toBeNull();
    expect(parseThreadLink("?project=p-1")).toBeNull();
    expect(parseThreadLink("?thread=")).toBeNull();
  });
});
