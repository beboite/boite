import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelRelease,
  pendingReleases,
  releaseAfterGrace,
  WORKTREE_GRACE_MS,
} from "./worktree-grace";

describe("worktree grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("gives the worktree back once the window has passed", () => {
    const release = vi.fn();
    releaseAfterGrace("t1", release);

    vi.advanceTimersByTime(WORKTREE_GRACE_MS - 1);
    expect(release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledOnce();
    expect(pendingReleases()).toBe(0);
  });

  /** The misclick this whole module exists for. */
  it("keeps it when the thread is restored inside the window", () => {
    const release = vi.fn();
    releaseAfterGrace("t1", release);

    expect(cancelRelease("t1")).toBe(true);
    vi.advanceTimersByTime(WORKTREE_GRACE_MS * 2);

    expect(release).not.toHaveBeenCalled();
    expect(pendingReleases()).toBe(0);
  });

  /** Nothing was waiting, so the restore has a directory to check for itself. */
  it("says so when there was nothing to keep", () => {
    expect(cancelRelease("never-closed")).toBe(false);
  });

  /**
   * Closed, restored, closed again. The first timer would otherwise still be
   * armed and would fire on a thread that had been open for minutes.
   */
  it("never leaves an older timer armed for the same thread", () => {
    const first = vi.fn();
    const second = vi.fn();
    releaseAfterGrace("t1", first);
    releaseAfterGrace("t1", second);

    expect(pendingReleases()).toBe(1);
    vi.advanceTimersByTime(WORKTREE_GRACE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
