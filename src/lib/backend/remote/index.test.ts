import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteBackend } from "./index";
import { completeHandshake, FakeWebSocket, ticketDoor } from "./fake-socket";

const THREAD = "11111111-2222-3333-4444-555555555555";

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

describe("writing to a boite that is not there", () => {
  /**
   * `sendInput` answers false for a socket that is not open and the frame is
   * dropped rather than queued, which is deliberate. Resolving anyway told
   * every caller the bytes had landed: the dispatch queue settled its row
   * `delivered` on it, and the line was gone.
   */
  it("rejects rather than resolving on a dropped socket", async () => {
    const backend = new RemoteBackend("ws://boite.test/ws", "cred", () => {}, () => {}, {
      autoReconnect: false,
    });
    await expect(backend.pty.write(THREAD, new Uint8Array([0x61]))).rejects.toThrow(
      /not connected/,
    );
    backend.dispose();
  });

  it("resolves once the socket is open, and the frame is on the wire", async () => {
    const door = ticketDoor();
    vi.stubGlobal("fetch", door.fetch);
    const backend = new RemoteBackend("ws://boite.test/ws", "cred", () => {}, () => {}, {
      autoReconnect: false,
    });
    const dial = backend.connect();
    door.issue();
    await settle();
    const ws = FakeWebSocket.last;
    expect(ws).toBeDefined();
    await completeHandshake(ws!);
    await dial;

    await expect(backend.pty.write(THREAD, new Uint8Array([0x61]))).resolves.toBeUndefined();
    expect(ws!.sent.filter((f) => f instanceof Uint8Array)).toHaveLength(1);

    // And the moment the link goes, the same call refuses instead of pretending.
    ws!.readyState = FakeWebSocket.CLOSING;
    await expect(backend.pty.write(THREAD, new Uint8Array([0x62]))).rejects.toThrow();
    backend.dispose();
  });
});
