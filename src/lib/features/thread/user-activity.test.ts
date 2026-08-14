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

const KEY = "boite.threadUserActivity";

async function load() {
  vi.resetModules();
  return await import("./user-activity.svelte");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("user activity", () => {
  it("answers with what the user typed, and null for a thread they never did", async () => {
    installStorage();
    const m = await load();
    m.noteUserInput("a", 1000);
    expect(m.userActivitySince("a")).toBe(1000);
    expect(m.userActivitySince("b")).toBeNull();
  });

  it("survives a restart, which is the whole reason it is on disk", async () => {
    const map = installStorage();
    const first = await load();
    first.noteUserInput("a", 4242);
    first.flushUserActivity();
    expect(JSON.parse(map.get(KEY) as string)).toEqual({ a: 4242 });

    const second = await load();
    expect(second.userActivitySince("a")).toBe(4242);
  });

  it("writes once for a burst of typing rather than once per keystroke", async () => {
    const map = installStorage();
    const spy = vi.spyOn(globalThis.localStorage, "setItem");
    const m = await load();
    for (let i = 0; i < 50; i++) m.noteUserInput("a", 1000 + i);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(map.get(KEY) as string)).toEqual({ a: 1049 });
  });

  it("keeps the most recent when the cap is passed", async () => {
    const map = installStorage();
    const m = await load();
    // 401 threads, oldest first, so the one that must fall out is `t0`.
    for (let i = 0; i <= 400; i++) m.noteUserInput(`t${i}`, 1000 + i);
    m.flushUserActivity();
    const written = JSON.parse(map.get(KEY) as string) as Record<string, number>;
    expect(Object.keys(written)).toHaveLength(400);
    expect(written.t0).toBeUndefined();
    expect(written.t400).toBe(1400);
  });

  it("drops a thread that was closed", async () => {
    installStorage();
    const m = await load();
    m.noteUserInput("a", 1000);
    m.forgetUserActivity("a");
    expect(m.userActivitySince("a")).toBeNull();
  });

  it("ignores a stored blob that is not a map of numbers", async () => {
    installStorage({ [KEY]: JSON.stringify({ a: "nope", b: 7 }) });
    const m = await load();
    expect(m.userActivitySince("a")).toBeNull();
    expect(m.userActivitySince("b")).toBe(7);
  });
});
