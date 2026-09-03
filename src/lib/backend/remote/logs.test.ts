import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteBackend } from "./index";
import { completeHandshake, FakeWebSocket, ticketDoor } from "./fake-socket";
import type { LogRecord } from "../types";

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

const RECORD: LogRecord = {
  ts: 1_756_000_000_000,
  seq: 12,
  host: "server",
  level: "warn",
  target: "boite_server::ws",
  msg: "rpc.failed",
  thread: "t-7",
};

describe("the log over the wire", () => {
  /**
   * The five bus methods by name, with the `records` envelope the WebSocket
   * protocol wraps a list in. The desktop reads the same answers bare, which is
   * the whole reason both sides can be one domain.
   */
  it("maps each call onto its bus method and unwraps the envelope", async () => {
    const { backend, ws } = await connected();

    const tail = backend.logs.tail({ limit: 5, level: "warn" });
    await settle();
    const tailId = ws.idOf("logs.tail")!;
    expect(tailId).toBeDefined();
    ws.answer(tailId, { records: [RECORD] });
    await expect(tail).resolves.toEqual([RECORD]);

    const query = backend.logs.query({ thread: "t-7", until: 5, limit: 200 });
    await settle();
    ws.answer(ws.idOf("logs.query")!, { records: [] });
    await expect(query).resolves.toEqual([]);

    const level = backend.logs.level("info,boite_core=debug");
    await settle();
    ws.answer(ws.idOf("logs.level")!, { level: "info,boite_core=debug" });
    await expect(level).resolves.toBe("info,boite_core=debug");

    const write = backend.logs.write([
      { ts: 1, level: "info", target: "ui.pane", msg: "pane.opened" },
    ]);
    await settle();
    ws.answer(ws.idOf("logs.write")!, null);
    await expect(write).resolves.toBeUndefined();

    // The params the server reads, not just the method names.
    const sent = ws.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as { method: string; params: Record<string, unknown> });
    const tailSent = sent.find((r) => r.method === "logs.tail")!;
    expect(tailSent.params).toEqual({ limit: 5, level: "warn" });
    const writeSent = sent.find((r) => r.method === "logs.write")!;
    expect((writeSent.params.records as unknown[]).length).toBe(1);

    backend.dispose();
  });

  /**
   * One `logs.subscribe` for the window, not one per handler. The server keys
   * the feed on the pairing id, so a second call says nothing new and a second
   * unsubscribe would take the feed away from a handler still watching.
   */
  it("subscribes once, fans out every batch, and unsubscribes on the last handler", async () => {
    const { backend, ws } = await connected();
    const first: LogRecord[][] = [];
    const second: LogRecord[][] = [];

    const offFirst = backend.logs.subscribe((batch) => first.push(batch));
    const offSecond = backend.logs.subscribe((batch) => second.push(batch));
    await settle();
    const subs = ws.rpcs().filter((r) => r.method === "logs.subscribe");
    expect(subs).toHaveLength(1);

    ws.onmessage?.({
      data: JSON.stringify({ event: "log.record", data: { records: [RECORD] } }),
    });
    expect(first).toEqual([[RECORD]]);
    expect(second).toEqual([[RECORD]]);

    // A handler that left stops hearing; the feed stays up for the other one.
    offFirst();
    await settle();
    expect(ws.rpcs().filter((r) => r.method === "logs.subscribe")).toHaveLength(1);
    ws.onmessage?.({
      data: JSON.stringify({ event: "log.record", data: { records: [RECORD] } }),
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);

    offSecond();
    await settle();
    const all = ws.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as { method: string; params: { on?: boolean } })
      .filter((r) => r.method === "logs.subscribe");
    expect(all.map((r) => r.params.on)).toEqual([true, false]);

    backend.dispose();
  });

  /** An event that is not the log's leaves the handlers alone. */
  it("ignores every other control event", async () => {
    const { backend, ws } = await connected();
    const seen: LogRecord[][] = [];
    backend.logs.subscribe((batch) => seen.push(batch));
    await settle();
    ws.onmessage?.({ data: JSON.stringify({ event: "todos.changed", data: {} }) });
    ws.onmessage?.({ data: JSON.stringify({ event: "log.record", data: { records: [] } }) });
    expect(seen).toHaveLength(0);
    backend.dispose();
  });
});
