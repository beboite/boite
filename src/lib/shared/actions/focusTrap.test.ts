import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOCUSABLE_SELECTOR, tabTarget } from "./focusTrap";

/**
 * Two halves, tested two ways.
 *
 * The cycling is pure and is where the off-by-one lives, so it is exercised
 * directly, on strings: the test run has no DOM by design (`vitest.config.ts`
 * says why), and a jsdom added for this one file would be a second environment
 * for the whole suite to carry.
 *
 * The other half is the wiring. Nothing at runtime notices an overlay that
 * stopped wearing the action: it opens, it looks right, and Tab quietly walks
 * out of it onto the page behind the scrim. Same silence `scroll-contract.test.ts`
 * was written for, asserted the same way — by reading the files.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("tabTarget", () => {
  const items = ["a", "b", "c"];

  it("moves nothing while the middle of the list has room", () => {
    expect(tabTarget(items, "a", false)).toBeNull();
    expect(tabTarget(items, "b", false)).toBeNull();
    expect(tabTarget(items, "b", true)).toBeNull();
    expect(tabTarget(items, "c", true)).toBeNull();
  });

  it("wraps at both ends", () => {
    expect(tabTarget(items, "c", false)).toBe("a");
    expect(tabTarget(items, "a", true)).toBe("c");
  });

  it("re-enters at the end Tab came from when focus is outside", () => {
    // The case the trap exists for: a list that re-rendered under the keyboard
    // dropped focus on <body>, so the next Tab has nowhere inside to move from.
    expect(tabTarget(items, null, false)).toBe("a");
    expect(tabTarget(items, null, true)).toBe("c");
  });

  it("wraps a single element onto itself", () => {
    expect(tabTarget(["only"], "only", false)).toBe("only");
    expect(tabTarget(["only"], "only", true)).toBe("only");
  });

  it("leaves an empty surface to the caller", () => {
    expect(tabTarget([], null, false)).toBeNull();
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("excludes the tabindex every dialog root wears", () => {
    // `tabindex="-1"` is how this app spells "focusable by script, not by Tab",
    // and a trap that offered its own root as a stop would cycle through the
    // scrim as if it were a control.
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it("skips the controls a disabled attribute has taken out of the order", () => {
    for (const tag of ["button", "input", "select", "textarea"]) {
      expect(FOCUSABLE_SELECTOR).toContain(`${tag}:not([disabled])`);
    }
  });
});

describe("the surfaces that trap focus", () => {
  // Every overlay finding 7 of the September 2026 UX audit names, plus the two
  // dialogs that had hand-rolled half of the trap before this action existed.
  const surfaces = {
    "the command palette": "../../features/palette/CommandPalette.svelte",
    "the telemetry consent overlay": "../../features/setup/TelemetryOverlay.svelte",
    "the setup wizard": "../../features/setup/SetupWizard.svelte",
    "the sync merge overlay": "../../features/sync/SyncMergeOverlay.svelte",
    "the remote project picker": "../../features/project/RemoteProjectPicker.svelte",
    "the shortcut colour popover": "../../features/settings/ShortcutEditor.svelte",
    "the sidebar launcher menu": "../../features/project/ProjectSidebar.svelte",
    "the confirm dialog": "../components/ConfirmDialog.svelte",
  };

  for (const [name, path] of Object.entries(surfaces)) {
    it(`${name} wears the action`, () => {
      expect(read(path)).toContain("use:focusTrap");
    });
  }
});
