import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const log = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("$lib/shared/services/logger.svelte", () => ({ logger: log }));

const { invoke } = await import("./ipc");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  tauri.invoke.mockReset();
  log.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const refuse = (message: string) => tauri.invoke.mockRejectedValue(new Error(message));

describe("a command that answers", () => {
  it("passes the answer through untouched and writes nothing", async () => {
    tauri.invoke.mockResolvedValue({ entries: [] });
    await expect(invoke("git_status", { path: "/w" })).resolves.toEqual({ entries: [] });
    expect(tauri.invoke).toHaveBeenCalledWith("git_status", { path: "/w" }, undefined);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("a command that refuses", () => {
  /**
   * The rejection is re-thrown. Swallowing it would turn a failure into an
   * undefined further down, which is worse than the silence this exists to fix.
   */
  it("still reaches the caller", async () => {
    refuse("not a repository");
    await expect(invoke("git_status", { path: "/w" })).rejects.toThrow("not a repository");
    expect(log.warn).toHaveBeenCalledWith("ipc", "git_status refused: not a repository");
  });

  /** A panel on a timer fails on every tick. Written every time, the log would
   * be one message repeated until the disk filled. */
  it("is written once, then stays quiet for a while", async () => {
    refuse("gone");
    await expect(invoke("git_log")).rejects.toThrow();
    await expect(invoke("git_log")).rejects.toThrow();
    vi.advanceTimersByTime(4_000);
    await expect(invoke("git_log")).rejects.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);

    // Past the window it is worth saying again: the panel is still broken.
    vi.advanceTimersByTime(2_000);
    await expect(invoke("git_log")).rejects.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  /** Keyed by the message too, so the same command failing on two paths is two
   * lines rather than one. */
  it("does not hide a second reason behind the first", async () => {
    tauri.invoke.mockRejectedValueOnce(new Error("/a is gone"));
    await expect(invoke("file_read")).rejects.toThrow();
    tauri.invoke.mockRejectedValueOnce(new Error("/b is gone"));
    await expect(invoke("file_read")).rejects.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  /** Reporting one of these would come straight back through this door. */
  it("never reports the log's own commands", async () => {
    refuse("disk full");
    for (const cmd of ["log_app_event", "read_app_log", "clear_app_log", "log_file_path"]) {
      await expect(invoke(cmd)).rejects.toThrow();
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reads a rejection that is not an Error", async () => {
    tauri.invoke.mockRejectedValue("plain string refusal");
    await expect(invoke("git_push")).rejects.toBe("plain string refusal");
    expect(log.warn).toHaveBeenCalledWith("ipc", "git_push refused: plain string refusal");
  });
});
