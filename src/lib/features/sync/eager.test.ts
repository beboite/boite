import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The bundle budget, guarded by a test rather than by a comment.
 *
 * Every `@codemirror/*` package in this app is reachable only through a dynamic
 * import today, which is the only reason the eager bundle fits its ceiling. The
 * sync store is different: the launch pull needs it, so it *is* on the boot
 * graph. One `@codemirror` import in it would pull the whole editor stack in
 * behind it — tens of kilobytes against a few of headroom — and the failure
 * would show up as a budget job going red long after the import was written.
 *
 * So the rule is written down here: the store ships strings and plain arrays,
 * and everything that knows what a chunk is lives behind the overlay.
 */
describe("what the sync store is allowed to reach", () => {
  const store = readFileSync("src/lib/features/sync/store.svelte.ts", "utf8");

  it("imports no CodeMirror", () => {
    expect(store).not.toMatch(/from ["']@codemirror/);
  });

  it("imports nothing from the merge tool's own modules", () => {
    // hunks.ts imports @codemirror/merge, so reaching it is the same mistake
    // one step removed.
    expect(store).not.toMatch(/from ["']\.\/hunks/);
    expect(store).not.toMatch(/from ["']\.\/hunkControls/);
    expect(store).not.toMatch(/SyncMergeOverlay/);
  });
});
