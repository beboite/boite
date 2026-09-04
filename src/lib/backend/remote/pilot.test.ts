import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteBackend } from "./index";
import { completeHandshake, FakeWebSocket, ticketDoor } from "./fake-socket";
import type { PilotEvent } from "$lib/features/pilot/types";

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function settle(turns = 5) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A backend on a link the test drives, with the handshake already done. */
async function connected() {
  const door = ticketDoor();
  vi.stubGlobal("fetch", door.fetch);
  const backend = new RemoteBackend("ws://boite.test/ws", "cred", () => {}, () => {}, {
    autoReconnect: false,
  });
  const dial = backend.connect();
  door.issue();
  await settle();
  const ws = FakeWebSocket.last!;
  await completeHandshake(ws);
  await dial;
  return { backend, ws };
}

const DELTA: PilotEvent = { kind: "item.delta", item_id: "msg_1#0", text: "ok" };

describe("the chat runtime over the wire", () => {
  /**
   * Every method by the name of the `pilot.*` command it is, with the envelope
   * the WebSocket protocol wraps a list in. The desktop reads the same answers
   * bare, which is the whole reason both sides are one domain.
   */
  it("maps each call onto its bus method and unwraps the envelope", async () => {
    const { backend, ws } = await connected();

    const catalog = backend.pilot.catalog(true);
    await settle();
    ws.answer(ws.idOf("pilot.catalog")!, { drivers: [], instances: [] });
    await expect(catalog).resolves.toEqual({ drivers: [], instances: [] });

    const opened = backend.pilot.open("t1");
    await settle();
    ws.answer(ws.idOf("pilot.thread.open")!, { thread_id: "t1", native_session_id: "n-7" });
    await expect(opened).resolves.toEqual({ thread_id: "t1", native_session_id: "n-7" });

    const turn = backend.pilot.startTurn("t1", "hello", "sonnet");
    await settle();
    ws.answer(ws.idOf("pilot.turn.start")!, { turnId: "turn_9" });
    await expect(turn).resolves.toBe("turn_9");

    const switched = backend.pilot.setModel("t1", {
      model: "opus",
      instance: { type: "fastpick", provider: "crof", model: "x" },
    });
    await settle();
    ws.answer(ws.idOf("pilot.model.set")!, { switch: "restart" });
    await expect(switched).resolves.toBe("restart");

    // Both cursor reads come back inside a key, and both are unwrapped.
    const items = backend.pilot.items("t1", 4, 10);
    await settle();
    ws.answer(ws.idOf("pilot.items")!, { items: [{ id: "i1" }] });
    await expect(items).resolves.toEqual([{ id: "i1" }]);

    const events = backend.pilot.events("t1", 4, 10);
    await settle();
    ws.answer(ws.idOf("pilot.events")!, { events: [] });
    await expect(events).resolves.toEqual([]);

    // The three that answer nothing still resolve, and resolve to nothing.
    for (const [method, call] of [
      ["pilot.turn.interrupt", backend.pilot.interrupt("t1")],
      ["pilot.mode.set", backend.pilot.setMode("t1", "yolo")],
      ["pilot.session.stop", backend.pilot.stop("t1")],
    ] as const) {
      await settle();
      ws.answer(ws.idOf(method)!, null);
      await expect(call).resolves.toBeUndefined();
    }

    const answered = backend.pilot.respond("t1", "r1", "allow");
    await settle();
    ws.answer(ws.idOf("pilot.request.respond")!, null);
    await expect(answered).resolves.toBeUndefined();

    // The params the host reads, not just the method names. A selection that
    // names no model sends null rather than leaving the key out: absent and
    // null are the same answer here, and the bus reads one of them.
    const sent = ws.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as { method: string; params: Record<string, unknown> });
    const byMethod = (method: string) => sent.find((r) => r.method === method)!.params;
    expect(byMethod("pilot.catalog")).toEqual({ refresh: true });
    expect(byMethod("pilot.turn.start")).toEqual({
      threadId: "t1",
      text: "hello",
      model: "sonnet",
    });
    expect(byMethod("pilot.model.set")).toEqual({
      threadId: "t1",
      model: "opus",
      instance: { type: "fastpick", provider: "crof", model: "x" },
    });
    expect(byMethod("pilot.items")).toEqual({ threadId: "t1", afterSeq: 4, limit: 10 });
    expect(byMethod("pilot.request.respond")).toEqual({
      threadId: "t1",
      requestId: "r1",
      option: "allow",
    });

    backend.dispose();
  });

  /** A turn with no selection says so rather than leaving the key out. */
  it("sends a null model when the turn names none", async () => {
    const { backend, ws } = await connected();
    // Never answered, so the dispose below fails it. Caught here rather than
    // left to land as an unhandled rejection in whatever test runs next.
    const turn = backend.pilot.startTurn("t1", "hi").catch(() => "");
    await settle();
    const sent = ws.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as { method: string; params: Record<string, unknown> })
      .find((r) => r.method === "pilot.turn.start")!;
    expect(sent.params).toEqual({ threadId: "t1", text: "hi", model: null });
    backend.dispose();
    await expect(turn).resolves.toBe("");
  });

  /**
   * One `pilot.subscribe` per thread, not per handler, and events reach only
   * the thread they name. The server keys the feed on the pairing id and the
   * thread, so a second call says nothing new and a second unsubscribe would
   * take the feed away from a pane still drawing it.
   */
  it("subscribes once per thread and fans out only that thread's events", async () => {
    const { backend, ws } = await connected();
    const one: PilotEvent[] = [];
    const two: PilotEvent[] = [];
    const other: PilotEvent[] = [];

    const offOne = backend.pilot.subscribe("t1", (event) => one.push(event));
    const offTwo = backend.pilot.subscribe("t1", (event) => two.push(event));
    backend.pilot.subscribe("t2", (event) => other.push(event));
    await settle();
    expect(ws.rpcs().filter((r) => r.method === "pilot.subscribe")).toHaveLength(2);

    ws.onmessage?.({
      data: JSON.stringify({ event: "pilot.event", data: { threadId: "t1", event: DELTA } }),
    });
    expect(one).toEqual([DELTA]);
    expect(two).toEqual([DELTA]);
    expect(other).toHaveLength(0);

    // A handler that left stops hearing; the feed stays up for the other one,
    // and no unsubscribe goes out while a pane is still drawing the thread.
    offOne();
    await settle();
    expect(ws.rpcs().filter((r) => r.method === "pilot.unsubscribe")).toHaveLength(0);
    ws.onmessage?.({
      data: JSON.stringify({ event: "pilot.event", data: { threadId: "t1", event: DELTA } }),
    });
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(2);

    offTwo();
    await settle();
    const gone = ws.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as { method: string; params: Record<string, unknown> })
      .filter((r) => r.method === "pilot.unsubscribe");
    expect(gone).toHaveLength(1);
    expect(gone[0].params).toEqual({ threadId: "t1" });

    backend.dispose();
  });

  /** An event that is not the chat's, or one naming nothing, changes nothing. */
  it("ignores every other control event", async () => {
    const { backend, ws } = await connected();
    const seen: PilotEvent[] = [];
    backend.pilot.subscribe("t1", (event) => seen.push(event));
    await settle();
    ws.onmessage?.({ data: JSON.stringify({ event: "todos.changed", data: {} }) });
    ws.onmessage?.({ data: JSON.stringify({ event: "pilot.event", data: { event: DELTA } }) });
    ws.onmessage?.({ data: JSON.stringify({ event: "pilot.event", data: { threadId: "t1" } }) });
    expect(seen).toHaveLength(0);
    backend.dispose();
  });
});
