import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS } from "$lib/domain/thread-ageing";
import type { Thread } from "$lib/types";

// The clock reaches for the whole app to read the thread list and for the
// settings store to read the auto-settle setting. Neither is what is under test:
// what is, is that a snoozed thread's hour arriving is something the sidebar can
// see, and that a snooze arms the timer that makes it arrive.
const threads: Thread[] = [];
const filed: [string, unknown][] = [];

vi.mock("$lib/app/store.svelte", () => ({
  app: {
    get threads() {
      return threads;
    },
    fileThread: (id: string, patch: unknown) => {
      filed.push([id, patch]);
      const thread = threads.find((t) => t.id === id);
      if (thread) thread.settledAt = Date.now();
      return Promise.resolve(true);
    },
  },
}));

const settingsState = { autoSettleDays: 0 };
vi.mock("$lib/features/settings/store.svelte", () => ({
  settings: { state: settingsState },
}));

vi.mock("./activity.svelte", () => ({ threadActivitySince: () => null }));

const { ageingNow, rearmThreadAgeing, startThreadAgeing } = await import("./ageing.svelte");

const NOW = 1_700_000_000_000;

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    label: "one",
    cmd: "bash",
    args: [],
    status: "ready",
    createdAt: NOW - 30 * DAY_MS,
    ...over,
  } as Thread;
}

let stop: (() => void) | null = null;

beforeEach(() => {
  threads.length = 0;
  filed.length = 0;
  settingsState.autoSettleDays = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe("the instant the lists age against", () => {
  /// `Date.now()` read inside a `$derived` is not a dependency of it, so the
  /// sidebar could only learn that a snooze had ended if something wrote state.
  /// This is that something: the value moves when the wake fires, and the lists
  /// read it instead of the clock.
  it("moves when a snooze ends", async () => {
    stop = startThreadAgeing();
    expect(ageingNow()).toBe(NOW);

    threads.push(thread({ snoozedUntil: NOW + 60_000 }));
    rearmThreadAgeing();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ageingNow()).toBe(NOW + 60_000);
  });

  /// The state it was in on every boot: nothing snoozed and auto-settle off arms
  /// no timer at all, so a snooze written without telling the clock is a wake
  /// nothing is waiting for.
  it("does not move on its own when nothing armed the wake", async () => {
    stop = startThreadAgeing();
    threads.push(thread({ snoozedUntil: NOW + 60_000 }));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(ageingNow()).toBe(NOW);
  });
});

describe("the pass a rearm runs", () => {
  /// Turning auto-settle on is a request about the threads that are already old.
  /// Arming the hourly timer and leaving the list alone would answer it up to an
  /// hour later, on a screen the user is looking at now.
  it("files away what the new setting already covers", () => {
    stop = startThreadAgeing();
    threads.push(thread({ createdAt: NOW - 30 * DAY_MS }));
    expect(filed).toHaveLength(0);

    settingsState.autoSettleDays = 3;
    rearmThreadAgeing();
    expect(filed).toEqual([["t1", { settled: true }]]);
  });

  /// A settle is written back through the store, which asks for a pass of its
  /// own whenever a snooze lands. So a pass runs over lists it has already been
  /// over, and has to leave them alone rather than write the same filing again.
  it("leaves alone what it has already filed", () => {
    stop = startThreadAgeing();
    threads.push(thread({ createdAt: NOW - 30 * DAY_MS }));
    settingsState.autoSettleDays = 3;
    rearmThreadAgeing();
    rearmThreadAgeing();
    expect(filed).toHaveLength(1);
  });
});
