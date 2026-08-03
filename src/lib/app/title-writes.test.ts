import { beforeEach, describe, expect, it, vi } from "vitest";

const written: [string, string | null][] = [];

vi.mock("$lib/storage/db", () => ({
  updateThreadTitle: (id: string, title: string | null) => {
    written.push([id, title]);
    return Promise.resolve();
  },
}));
vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { error: () => {} },
}));

const { TitleWrites } = await import("./title-writes");

describe("title writes", () => {
  beforeEach(() => {
    written.length = 0;
    vi.useFakeTimers();
  });

  /// An agent streaming tokens rewrites its OSC title continuously. Before the
  /// window existed that was a SQLite write per token.
  it("writes a burst once instead of once per title", async () => {
    const writes = new TitleWrites(() => "local");
    for (let i = 0; i < 50; i++) writes.queue("t1", `title ${i}`);
    expect(written).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600);
    expect(written).toEqual([["t1", "title 49"]]);
  });

  /// A fixed window rather than a trailing debounce, which is the whole design:
  /// a trailing debounce would never fire while the agent kept talking.
  it("does not wait for the burst to end", async () => {
    const writes = new TitleWrites(() => "local");
    for (let round = 0; round < 3; round++) {
      writes.queue("t1", `round ${round}`);
      await vi.advanceTimersByTimeAsync(400);
      writes.queue("t1", `round ${round} again`);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(written.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps one title per thread, not one per burst", async () => {
    const writes = new TitleWrites(() => "local");
    writes.queue("t1", "one");
    writes.queue("t2", "two");
    writes.queue("t1", "one again");
    await vi.advanceTimersByTimeAsync(600);
    expect(written.sort()).toEqual([
      ["t1", "one again"],
      ["t2", "two"],
    ]);
  });

  /// Applying an update ends the process on purpose, and the window is long
  /// enough to lose the last title of every thread.
  it("flushes on demand without waiting for the window", async () => {
    const writes = new TitleWrites(() => "local");
    writes.queue("t1", "unsaved");
    await writes.flush();
    expect(written).toEqual([["t1", "unsaved"]]);

    // And the timer it cancelled does not fire a second write.
    await vi.advanceTimersByTimeAsync(600);
    expect(written).toHaveLength(1);
  });

  /// A rename is the user typing a name. An OSC title queued half a second
  /// earlier would otherwise land on top of it.
  it("forgets a queued title when the thread is renamed", async () => {
    const writes = new TitleWrites(() => "local");
    writes.queue("t1", "from the agent");
    writes.queue("t2", "untouched");
    writes.cancel("t1");
    await vi.advanceTimersByTimeAsync(600);
    expect(written).toEqual([["t2", "untouched"]]);
  });

  /// A workspace switch drops what was queued for the workspace being left.
  it("discards a pending batch without writing it", async () => {
    const writes = new TitleWrites(() => "local");
    writes.queue("t1", "gone");
    writes.discard();
    await vi.advanceTimersByTimeAsync(600);
    expect(written).toHaveLength(0);
  });

  /// The origin is asked for at flush time, not remembered with the title: a
  /// thread can move workspace inside the window, and the row it has to reach
  /// is the one it is in now.
  it("asks where the thread is when it writes, not when it queues", async () => {
    let origin: "local" | "remote" = "local";
    const asked: (string | undefined)[] = [];
    const writes = new TitleWrites((id) => {
      asked.push(id);
      return origin;
    });
    writes.queue("t1", "title");
    expect(asked).toHaveLength(0);
    origin = "remote";
    await vi.advanceTimersByTimeAsync(600);
    expect(asked).toEqual(["t1"]);
  });
});
