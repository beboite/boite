import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurn, AgentTurnQuery, Backend } from "$lib/backend/types";

// The real one drags the whole backend graph in behind it, and none of what is
// tested here says anything.
vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

type Module = typeof import("./agent-turns");

const QUERY: AgentTurnQuery[] = [{ kind: "claude", sessionId: "a", cwd: "/w/one" }];

function claude(id: string, state: string): AgentTurn {
  return { kind: "claude", sessionId: id, state, cwd: "/w/one" };
}

/** A backend whose only job is to hand back whatever the test decided. */
function backendOf(answer: () => Promise<AgentTurn[]>): Backend {
  return { session: { agentTurns: answer } } as unknown as Backend;
}

/** Lets every already-settled promise run its handlers. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

// The module keeps its poll state in module scope, so each test gets its own
// copy of it rather than inheriting the previous one's clock.
let mod: Module;
// Well past POLL_MS, so the very first poll of a test is never held back by the
// zero the module starts its last-read clock on.
let clock = 1_000_000;

beforeEach(async () => {
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.resetModules();
  mod = await import("./agent-turns");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agentTurns.poll", () => {
  it("asks again once a read has gone past its deadline", async () => {
    // A promise that never settles: a hung `invoke`, or a remote boite's rpc,
    // which has no timeout of its own. Clearing `inFlight` in `.finally()` alone
    // latched it true for good, and every agent thread then kept whatever state
    // it had last declared for the life of the window, silently.
    let calls = 0;
    const backend = backendOf(() => {
      calls += 1;
      return new Promise<AgentTurn[]>(() => {});
    });

    mod.agentTurns.poll(backend, QUERY);
    expect(calls).toBe(1);

    // Still inside the deadline: one read at a time is the whole point of the
    // flag, and this must not turn into a poll per tick.
    clock += mod.POLL_DEADLINE_MS - 1;
    mod.agentTurns.poll(backend, QUERY);
    expect(calls).toBe(1);

    clock += 1;
    mod.agentTurns.poll(backend, QUERY);
    expect(calls).toBe(2);

    // And the successor gets a deadline of its own rather than a free pass.
    clock += mod.POLL_MS;
    mod.agentTurns.poll(backend, QUERY);
    expect(calls).toBe(2);
    await settled();
  });

  it("never lets an abandoned read publish its answer", async () => {
    // The one that timed out may still come back, with an answer collected before
    // the one that replaced it. Landing it would put the thread back on a state
    // its agent has already moved off.
    const abandoned: { release: ((turns: AgentTurn[]) => void) | null } = { release: null };
    let calls = 0;
    const backend = backendOf(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<AgentTurn[]>((resolve) => {
          abandoned.release = resolve;
        });
      }
      return Promise.resolve([claude("a", "idle")]);
    });

    mod.agentTurns.poll(backend, QUERY);
    clock += mod.POLL_DEADLINE_MS;
    mod.agentTurns.poll(backend, QUERY);
    await settled();
    expect(mod.agentTurns.stateOf("claude", "a", "/w/one")).toEqual({ state: "idle" });

    abandoned.release?.([claude("a", "busy")]);
    await settled();
    expect(mod.agentTurns.stateOf("claude", "a", "/w/one")).toEqual({ state: "idle" });
  });

  it("holds the last answer when a read fails", async () => {
    // A failed read is not evidence a turn ended, and the flag still has to come
    // back down or nothing would ever ask again.
    let calls = 0;
    const backend = backendOf(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve([claude("a", "busy")])
        : Promise.reject(new Error("socket closed"));
    });

    mod.agentTurns.poll(backend, QUERY);
    await settled();
    clock += mod.POLL_MS;
    mod.agentTurns.poll(backend, QUERY);
    await settled();
    expect(mod.agentTurns.stateOf("claude", "a", "/w/one")).toEqual({ state: "busy" });

    clock += mod.POLL_MS;
    mod.agentTurns.poll(backend, QUERY);
    expect(calls).toBe(3);
  });

  it("says nothing at all until the first answer has landed", () => {
    // Silence before that is "nobody has been asked yet", and reading it as "no
    // agent knows this thread" demotes a working thread on every launch.
    const backend = backendOf(() => new Promise<AgentTurn[]>(() => {}));
    expect(mod.agentTurns.stateOf("claude", "a", "/w/one")).toBeNull();
    mod.agentTurns.poll(backend, QUERY);
    expect(mod.agentTurns.stateOf("claude", "a", "/w/one")).toBeNull();
  });
});
