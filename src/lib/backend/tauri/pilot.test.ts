import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PilotEvent } from "$lib/features/pilot/types";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
const tauriEvent = vi.hoisted(() => ({ listen: vi.fn() }));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

vi.mock("./ipc", () => ({ invoke: ipc.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));
vi.mock("$lib/shared/log", () => ({ log }));

const { tauriPilot } = await import("./rpc");

/** The window listener the feed installs, so a test can push an event at it. */
let deliver: ((message: { payload: unknown }) => void) | null = null;
const unlisten = vi.fn();

beforeEach(() => {
  ipc.invoke.mockReset();
  ipc.invoke.mockResolvedValue(null);
  unlisten.mockReset();
  deliver = null;
  tauriEvent.listen.mockReset();
  tauriEvent.listen.mockImplementation(
    (_name: string, handler: (message: { payload: unknown }) => void) => {
      deliver = handler;
      return Promise.resolve(unlisten);
    },
  );
});

async function settle(turns = 5) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

/** What one command was called with, by the command name. */
function calledWith(command: string): Record<string, unknown> {
  const call = ipc.invoke.mock.calls.find((args) => args[0] === command);
  expect(call, `${command} was never invoked`).toBeDefined();
  return (call![1] as { params: Record<string, unknown> }).params;
}

const DELTA: PilotEvent = { kind: "item.delta", item_id: "msg_1#0", text: "ok" };

describe("the chat runtime through the desktop door", () => {
  /**
   * Every method by the name of the Tauri command it is, with the params the
   * bus reads. The desktop reads the answers bare, which is the difference from
   * the WebSocket: no `items` or `events` envelope to unwrap.
   */
  it("maps each call onto its command and reads the answer bare", async () => {
    ipc.invoke.mockResolvedValueOnce({ drivers: [], instances: [] });
    await expect(tauriPilot.catalog(true)).resolves.toEqual({ drivers: [], instances: [] });
    expect(calledWith("pilot_catalog")).toEqual({ refresh: true });

    ipc.invoke.mockResolvedValueOnce({ thread_id: "t1", native_session_id: "n-7" });
    await expect(tauriPilot.open("t1")).resolves.toEqual({
      thread_id: "t1",
      native_session_id: "n-7",
    });

    ipc.invoke.mockResolvedValueOnce({ turnId: "turn_9" });
    await expect(tauriPilot.startTurn("t1", "hello", "sonnet")).resolves.toBe("turn_9");
    expect(calledWith("pilot_turn_start")).toEqual({
      threadId: "t1",
      text: "hello",
      model: "sonnet",
    });

    ipc.invoke.mockResolvedValueOnce({ switch: "in_session" });
    await expect(
      tauriPilot.setModel("t1", { model: "opus", instance: null }),
    ).resolves.toBe("in_session");
    expect(calledWith("pilot_model_set")).toEqual({
      threadId: "t1",
      model: "opus",
      instance: null,
    });

    // The cursor reads answer the list itself, not a key holding one.
    ipc.invoke.mockResolvedValueOnce([{ id: "i1" }]);
    await expect(tauriPilot.items("t1", 4, 10)).resolves.toEqual([{ id: "i1" }]);
    expect(calledWith("pilot_items")).toEqual({ threadId: "t1", afterSeq: 4, limit: 10 });

    ipc.invoke.mockResolvedValueOnce([]);
    await expect(tauriPilot.events("t1")).resolves.toEqual([]);
    expect(calledWith("pilot_events")).toEqual({
      threadId: "t1",
      afterSeq: 0,
      limit: undefined,
    });

    // The four that answer nothing still resolve, and resolve to nothing.
    await expect(tauriPilot.interrupt("t1")).resolves.toBeUndefined();
    await expect(tauriPilot.setMode("t1", "yolo")).resolves.toBeUndefined();
    await expect(tauriPilot.stop("t1")).resolves.toBeUndefined();
    await expect(tauriPilot.respond("t1", "r1", "allow")).resolves.toBeUndefined();
    expect(calledWith("pilot_mode_set")).toEqual({ threadId: "t1", mode: "yolo" });
    expect(calledWith("pilot_request_respond")).toEqual({
      threadId: "t1",
      requestId: "r1",
      option: "allow",
    });
  });

  /** A turn with no selection says so rather than leaving the key out. */
  it("sends a null model when the turn names none", async () => {
    ipc.invoke.mockResolvedValueOnce({ turnId: "turn_1" });
    await tauriPilot.startTurn("t1", "hi");
    expect(calledWith("pilot_turn_start")).toEqual({
      threadId: "t1",
      text: "hi",
      model: null,
    });
  });

  /**
   * One window listener whatever is open, one `pilot_subscribe` per thread,
   * and an event reaching only the thread it names. A channel per pane would
   * mean the sink knowing which panes exist, which is the window's business.
   */
  it("subscribes per thread and fans out only that thread's events", async () => {
    const one: PilotEvent[] = [];
    const two: PilotEvent[] = [];
    const other: PilotEvent[] = [];

    const offOne = tauriPilot.subscribe("t1", (event) => one.push(event));
    const offTwo = tauriPilot.subscribe("t1", (event) => two.push(event));
    const offOther = tauriPilot.subscribe("t2", (event) => other.push(event));
    await settle();
    const subscribes = ipc.invoke.mock.calls.filter((args) => args[0] === "pilot_subscribe");
    expect(subscribes).toHaveLength(2);

    deliver!({ payload: { threadId: "t1", event: DELTA } });
    expect(one).toEqual([DELTA]);
    expect(two).toEqual([DELTA]);
    expect(other).toHaveLength(0);

    // A payload naming no thread, or no event, is dropped rather than fanned
    // out to whoever happens to be listening.
    deliver!({ payload: { event: DELTA } });
    deliver!({ payload: { threadId: "t1" } });
    expect(one).toHaveLength(1);

    // A handler that left stops hearing; nothing is unsubscribed while another
    // handler is still drawing the same thread.
    offOne();
    await settle();
    expect(ipc.invoke.mock.calls.filter((a) => a[0] === "pilot_unsubscribe")).toHaveLength(0);
    deliver!({ payload: { threadId: "t1", event: DELTA } });
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(2);

    offTwo();
    await settle();
    const gone = ipc.invoke.mock.calls.filter((a) => a[0] === "pilot_unsubscribe");
    expect(gone).toHaveLength(1);
    expect((gone[0][1] as { params: unknown }).params).toEqual({ threadId: "t1" });
    // The other thread still hears, its own subscription untouched.
    deliver!({ payload: { threadId: "t2", event: DELTA } });
    expect(other).toEqual([DELTA]);

    offOther();
    await settle();
    const all = ipc.invoke.mock.calls.filter((a) => a[0] === "pilot_unsubscribe");
    expect(all.map((a) => (a[1] as { params: { threadId: string } }).params.threadId)).toEqual([
      "t1",
      "t2",
    ]);
    // Nothing is drawing a chat any more, so the window listener is dropped.
    expect(unlisten).toHaveBeenCalled();
  });

  /**
   * A refused subscribe is written down and swallowed: the caller has already
   * been handed its unsubscribe, and throwing out of a fire-and-forget would
   * land as an unhandled rejection rather than anywhere anyone reads.
   */
  it("writes a refused subscribe rather than throwing it at the pane", async () => {
    ipc.invoke.mockRejectedValueOnce(new Error("outside the roots"));
    const off = tauriPilot.subscribe("t9", () => {});
    await settle();
    expect(log.warn).toHaveBeenCalledWith(
      "backend.pilot",
      "pilot.subscribe.refused",
      expect.objectContaining({ thread: "t9" }),
    );
    off();
  });
});
