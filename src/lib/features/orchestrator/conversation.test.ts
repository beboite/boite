import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorMessage } from "$lib/backend/types";
import { Conversation } from "./conversation.svelte";

function msg(id: string, text = id): OrchestratorMessage {
  return { id, role: "user", text, aloud: null, urgency: null, at: 1 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the orchestrator conversation", () => {
  it("reads from its cursor, and only when told to", async () => {
    vi.useFakeTimers();
    const calls: (string | null)[] = [];
    const pages: OrchestratorMessage[][] = [[msg("a"), msg("b")], [msg("c")]];
    const convo = new Conversation(async (sinceId) => {
      calls.push(sinceId);
      return pages.shift() ?? [];
    });

    await convo.refresh();
    expect(convo.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(calls).toEqual([null]);

    // The whole point of the pulse: a quiet chat costs nothing. Hours of fake
    // time pass and the store makes not one call — there is no timer to fire.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(calls.length).toBe(1);

    await convo.refresh();
    expect(calls).toEqual([null, "b"]);
    expect(convo.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("coalesces refreshes racing each other", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const convo = new Conversation(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((r) => {
          release = r;
        });
        return [msg("a")];
      }
      return [msg("b")];
    });

    const first = convo.refresh();
    // Three callers pile on while the first read hangs; they ride it and cost
    // one follow-up between them, not three.
    void convo.refresh();
    void convo.refresh();
    release!();
    await first;
    await vi.waitFor(() =>
      expect(convo.messages.map((m) => m.id)).toEqual(["a", "b"]),
    );
    expect(calls).toBe(2);
  });

  it("drops what it already holds", async () => {
    const convo = new Conversation(async () => [msg("a"), msg("b")]);
    await convo.refresh();
    // A truncated cursor can replay the tail; the same id twice is one row.
    await convo.refresh();
    expect(convo.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
});
