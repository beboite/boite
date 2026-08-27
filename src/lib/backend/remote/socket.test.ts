import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket } from "./socket";
import { completeHandshake, FakeWebSocket, ticketDoor } from "./fake-socket";

const THREAD = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Lets the dial's awaits (fetch, json, the handshake continuations) run. */
async function settle(turns = 5) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

function make(door = ticketDoor()) {
  vi.stubGlobal("fetch", door.fetch);
  const states: string[] = [];
  const socket = new Socket("ws://boite.test/ws", "cred", (s) => states.push(s), () => {}, {
    autoReconnect: false,
  });
  return { socket, states, door };
}

describe("a close that lands while the ticket is still in the air", () => {
  /**
   * The dial is two awaited steps and the first one has no socket to close, so
   * `close()` had nothing to act on: the ticket came back afterwards and opened
   * a WebSocket onto a socket object the caller had already let go of.
   */
  it("opens no WebSocket once the ticket arrives", async () => {
    const { socket, door } = make();
    const dial = socket.connect();
    const failed = dial.catch((e: unknown) => e);

    socket.close();
    door.issue();
    await failed;
    await settle();

    expect(FakeWebSocket.made).toHaveLength(0);
    expect(socket.state).toBe("disconnected");
  });

  it("cancels the ticket round trip rather than letting it finish", async () => {
    const { socket, door } = make();
    const failed = socket.connect().catch((e: unknown) => e);
    socket.close();
    await failed;
    expect(door.signals.some((s) => s.aborted)).toBe(true);
  });

  /** A dial nobody is on any more must not publish a state either. */
  it("publishes nothing after the close", async () => {
    const { socket, states, door } = make();
    const failed = socket.connect().catch((e: unknown) => e);
    socket.close();
    const afterClose = states.length;
    door.issue();
    await failed;
    await settle();
    expect(states.slice(afterClose)).toEqual([]);
  });

  /**
   * The other half: a dial the caller replaced. `retryNow` reads `#dialing`, so
   * an abandoned attempt clearing it would tell the socket no dial is running
   * while a newer one is mid-flight.
   */
  it("leaves a newer dial in charge", async () => {
    const { socket, door } = make();
    const first = socket.connect().catch((e: unknown) => e);
    const second = socket.connect().catch((e: unknown) => e);
    // Only the live dial's ticket is answered; the first one's fetch was
    // cancelled when the second took over.
    door.issue("t-2");
    await first;
    await settle();
    // One socket, from the dial that was still the live one.
    expect(FakeWebSocket.made).toHaveLength(1);
    socket.close();
    await second;
  });
});

describe("input on a socket that is not open", () => {
  it("is refused rather than reported as sent", async () => {
    const { socket, door } = make();
    const dial = socket.connect();
    door.issue();
    await settle();
    const ws = FakeWebSocket.last;
    expect(ws).toBeDefined();
    await completeHandshake(ws!);
    await dial;

    expect(socket.state).toBe("connected");
    expect(socket.sendInput(THREAD, new Uint8Array([0x61]))).toBe(true);
    const framesWhenOpen = ws!.sent.filter((f) => f instanceof Uint8Array).length;

    // The browser has moved on and `onclose` has not run yet, so this side
    // still reads "connected". The readyState is the only thing that knows.
    ws!.readyState = FakeWebSocket.CLOSING;
    expect(socket.state).toBe("connected");
    expect(socket.sendInput(THREAD, new Uint8Array([0x62]))).toBe(false);
    expect(ws!.sent.filter((f) => f instanceof Uint8Array)).toHaveLength(framesWhenOpen);
    socket.close();
  });

  it("is refused when there is no socket at all", () => {
    const { socket } = make();
    expect(socket.sendInput(THREAD, new Uint8Array([0x61]))).toBe(false);
  });
});
