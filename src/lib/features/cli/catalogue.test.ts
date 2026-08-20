import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_PRESETS } from "$lib/features/settings/cliPresets";

/**
 * The two halves of one CLI have to name the same thing.
 *
 * The Rust catalogue owns what can be installed, from where, and which
 * directories a purge is allowed to touch; `cliPresets.ts` owns the label, the
 * brand glyph and the documentation link. They meet on the id, which the panel
 * uses to draw a row: a preset the catalogue does not know draws a row with no
 * buttons, and a catalogue entry no preset knows draws a row with no name.
 *
 * Read off the Rust source rather than asked of a running backend, because this
 * has to fail in CI on a machine with no window open.
 */
const catalogue = readFileSync(
  fileURLToPath(new URL("../../../../crates/boite-core/src/cli_manager/catalog.rs", import.meta.url)),
  "utf8",
);

/** The `id:` of every entry in `CLIS`, in table order. */
function rustIds(): string[] {
  const table = catalogue.slice(catalogue.indexOf("pub const CLIS"));
  return [...table.matchAll(/^\s{8}id: "([a-z-]+)",$/gm)].map((m) => m[1]);
}

describe("the CLI catalogue and the presets", () => {
  it("name the same CLIs, in the same order", () => {
    expect(rustIds()).toEqual(CLI_PRESETS.map((preset) => preset.id));
  });

  it("agree on which executable each one is", () => {
    const table = catalogue.slice(catalogue.indexOf("pub const CLIS"));
    const pairs = [...table.matchAll(/id: "([a-z-]+)",\s*\n(?:\s*\/\/[^\n]*\n)*\s*exe: "([^"]+)"/g)];
    const byId = new Map(pairs.map((m) => [m[1], m[2]]));
    for (const preset of CLI_PRESETS) {
      expect(byId.get(preset.id), preset.id).toBe(preset.executable);
    }
  });
});
