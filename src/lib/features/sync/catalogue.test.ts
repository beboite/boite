import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLI_PRESETS } from "$lib/features/settings/cliPresets";

/**
 * The panel's rows and the backend's table name the same agents.
 *
 * The sync tab draws one row per preset plus the shared tree, and the backend
 * declares one entry per agent — including the ones whose entry is empty,
 * because "nothing syncs for this one yet" is a decision and reads differently
 * from an omission. If the two lists drift, an agent is either drawn with a
 * switch that controls nothing, or has a decision nobody can reach.
 *
 * The Rust source is read directly rather than asked over the bus, so this fails
 * in CI with no window open and no backend running.
 */
const MANIFEST = "crates/boite-core/src/sync/manifest.rs";

function rustList(name: string): string[] {
  const source = readFileSync(MANIFEST, "utf8");
  const block = new RegExp(`${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(source);
  if (!block) throw new Error(`${name} is no longer declared in ${MANIFEST}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("the agents the sync tab and the backend agree on", () => {
  it("are the same set", () => {
    // Both sides are fresh arrays, so sorting in place disturbs nothing.
    expect(rustList("KNOWN_CLIS").sort()).toEqual(
      CLI_PRESETS.map((preset) => preset.id).sort(),
    );
  });

  it("are in the same order, which is the order the rows are drawn in", () => {
    expect(rustList("KNOWN_CLIS")).toEqual(CLI_PRESETS.map((preset) => preset.id));
  });

  it("does not include the shared tree, which belongs to no agent", () => {
    expect(rustList("KNOWN_CLIS")).not.toContain("agents");
  });
});
