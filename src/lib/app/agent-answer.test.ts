import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A backend whose answer channel is a real method reading a private field, so a
 * caller that pulled the function off the object instead of calling it on the
 * object fails here the way `RemoteBackend` fails on the wire.
 */
class Channel {
  #name: string;
  readonly answered: { id: string; payload: Record<string, unknown> }[] = [];
  constructor(name: string) {
    this.#name = name;
  }
  answerAgentRequest(id: string, payload: Record<string, unknown>): Promise<void> {
    this.answered.push({ id, payload });
    void this.#name;
    return Promise.resolve();
  }
}

const world = vi.hoisted(() => ({
  local: null as unknown,
  remote: null as unknown,
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));

vi.mock("$lib/backend", () => ({
  workspace: {
    local: () => world.local,
    get remoteBackend() {
      return world.remote;
    },
  },
}));
vi.mock("$lib/shared/services/logger.svelte", () => ({ logger: log }));

const { answerBackend, answerRequest } = await import("./agent-answer");

let local: Channel;
let remote: Channel;

beforeEach(() => {
  local = new Channel("local");
  remote = new Channel("remote");
  world.local = local;
  world.remote = remote;
  log.warn.mockReset();
});

describe("dynamic mode, where both transports are live", () => {
  /**
   * The bug this covers: the answer used to go to `workspace.current()`, which
   * in dynamic mode is the local device. The desktop's IPC has never heard of
   * the id, so the boite's agent sat out its timeout with the work already
   * done — and asked again.
   */
  it("answers a boite's question down the boite's own channel", async () => {
    await answerRequest({ requestId: "r-1" }, { ok: true }, "boite");
    expect(remote.answered).toEqual([{ id: "r-1", payload: { ok: true } }]);
    expect(local.answered).toEqual([]);
  });

  it("answers this window's own question down the Tauri bus", async () => {
    await answerRequest({ requestId: "r-2" }, { ok: true }, "device");
    expect(local.answered).toEqual([{ id: "r-2", payload: { ok: true } }]);
    expect(remote.answered).toEqual([]);
  });

  it("routes by who asked, never by which transport is active", () => {
    expect(answerBackend("boite")).toBe(remote);
    expect(answerBackend("device")).toBe(local);
  });
});

describe("when there is nothing to answer on", () => {
  it("says so in the log instead of dropping it silently", async () => {
    world.remote = null;
    await answerRequest({ requestId: "r-3" }, { ok: true }, "boite");
    expect(local.answered).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "agent-request",
      "no channel to answer on, dropping the answer",
      { from: "boite" },
    );
  });

  /** A request with no id owes nobody an answer. */
  it("stays quiet for a request that carries no id", async () => {
    await answerRequest({}, { ok: true }, "boite");
    expect(remote.answered).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
