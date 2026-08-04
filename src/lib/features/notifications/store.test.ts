import { beforeEach, describe, expect, it } from "vitest";

/**
 * How long a card stays up, which is the whole difference between a message
 * that was reported and one that was read. Every kind used to expire on the
 * same short count, sized for "Copied": a sentence naming three files was gone
 * before it had been found on screen.
 */
import { notifications } from "./store.svelte";

function only() {
  expect(notifications.toasts.length).toBe(1);
  return notifications.toasts[0];
}

describe("how long a toast stays up", () => {
  beforeEach(() => {
    // Not `for … of` over a copy: dismissing splices the array being read.
    while (notifications.toasts.length > 0) {
      notifications.dismiss(notifications.toasts[0].id);
    }
  });

  it("gives a long message longer than a short one", () => {
    notifications.error("Push failed");
    const short = only().durationMs;
    notifications.dismiss(only().id);

    notifications.error(
      "Push failed: the remote branch has moved on since this worktree was made, so nothing was sent and the branch here is unchanged.",
    );
    expect(only().durationMs!).toBeGreaterThan(short!);
  });

  it("keeps a floor per kind, since the kinds are not read the same way", () => {
    notifications.success("Copié");
    const ok = only().durationMs!;
    notifications.dismiss(only().id);

    notifications.error("Échec");
    const bad = only().durationMs!;
    notifications.dismiss(only().id);

    notifications.warning("Attention");
    const warn = only().durationMs!;

    expect(ok).toBeLessThan(warn);
    expect(warn).toBeLessThan(bad);
  });

  it("counts the detail line, which is text on screen like any other", () => {
    notifications.warning("Main is dirty");
    const bare = only().durationMs!;
    notifications.dismiss(only().id);

    notifications.warning(
      "Main is dirty",
      undefined,
      "src/lib/features/thread/api.ts, src/lib/backend/types.ts, README.md",
    );
    expect(only().durationMs!).toBeGreaterThanOrEqual(bare);
  });

  // The documented meaning of `null`, which the store used to promise in a
  // comment and then override with a three second default.
  it("lets null mean a card that waits to be dismissed by hand", () => {
    notifications.info("Waiting for you", null);
    expect(only().durationMs).toBeNull();
  });

  it("takes an explicit duration over anything it would have worked out", () => {
    notifications.error("Short on purpose", 500);
    expect(only().durationMs).toBe(500);
  });

  // A poll that keeps failing raises the same text every 10s; the card that is
  // already up says what it is about now rather than stacking a second one.
  it("refreshes the card that is already up, specifics included", () => {
    notifications.error("Refresh failed", null, "first");
    const id = only().id;
    notifications.error("Refresh failed", null, "second");
    expect(only().id).toBe(id);
    expect(only().detail).toBe("second");
    expect(only().resetKey).toBe(1);
  });
});
