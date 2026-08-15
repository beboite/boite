import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The registry reads localStorage once, as the module loads, so every case here
 * installs its store first and imports after. `resetModules` is what makes the
 * second import a fresh read rather than the first one's cache.
 */
function installStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  vi.stubGlobal("localStorage", store);
  return map;
}

const KEY = "boite.threadWorkStarted";
const RETIRED_KEY = "boite.threadUserActivity";

async function load() {
  vi.resetModules();
  return await import("./work-activity.svelte");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("work activity", () => {
  it("answers with when work started, and null for a thread none did", async () => {
    installStorage();
    const m = await load();
    m.noteWorkStarted("a", 1000);
    expect(m.workStartedSince("a")).toBe(1000);
    expect(m.workStartedSince("b")).toBeNull();
  });

  it("survives a restart, which is the whole reason it is on disk", async () => {
    const map = installStorage();
    const first = await load();
    first.noteWorkStarted("a", 4242);
    first.flushWorkActivity();
    expect(JSON.parse(map.get(KEY) as string)).toEqual({ a: 4242 });

    const second = await load();
    expect(second.workStartedSince("a")).toBe(4242);
  });

  it("writes once for a burst rather than once per stamp", async () => {
    const map = installStorage();
    const spy = vi.spyOn(globalThis.localStorage, "setItem");
    const m = await load();
    for (let i = 0; i < 50; i++) m.noteWorkStarted("a", 1000 + i);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(map.get(KEY) as string)).toEqual({ a: 1049 });
  });

  it("keeps the most recent when the cap is passed", async () => {
    const map = installStorage();
    const m = await load();
    // 401 threads, oldest first, so the one that must fall out is `t0`.
    for (let i = 0; i <= 400; i++) m.noteWorkStarted(`t${i}`, 1000 + i);
    m.flushWorkActivity();
    const written = JSON.parse(map.get(KEY) as string) as Record<string, number>;
    expect(Object.keys(written)).toHaveLength(400);
    expect(written.t0).toBeUndefined();
    expect(written.t400).toBe(1400);
  });

  it("drops a thread that was closed", async () => {
    installStorage();
    const m = await load();
    m.noteWorkStarted("a", 1000);
    m.forgetWorkStarted("a");
    expect(m.workStartedSince("a")).toBeNull();
  });

  it("ignores a stored blob that is not a map of numbers", async () => {
    installStorage({ [KEY]: JSON.stringify({ a: "nope", b: 7 }) });
    const m = await load();
    expect(m.workStartedSince("a")).toBeNull();
    expect(m.workStartedSince("b")).toBe(7);
  });

  /** The order used to be about typing, and that blob answers a question
      nothing asks now. */
  it("drops what the typing-ordered build left behind", async () => {
    const map = installStorage({ [RETIRED_KEY]: JSON.stringify({ a: 1 }) });
    await load();
    expect(map.has(RETIRED_KEY)).toBe(false);
  });
});
