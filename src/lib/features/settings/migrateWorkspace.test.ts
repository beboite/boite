import { describe, expect, it } from "vitest";
import {
  dropRetiredKeys,
  readExperimentWorkspace,
  RETIRED_SETTINGS_KEYS,
} from "./store.svelte";

/**
 * The one-shot fold, read off a stored blob.
 *
 * Four switches over one feature became one, and the only thing that can go
 * wrong here is silent: a device that had armed Home or the orchestrator opens
 * the app with the workspace gone and nothing saying why. So the OR is asserted
 * per old key rather than once, and the explicit value is asserted to win, or
 * turning the folded switch off would be undone by the dead keys sitting beside
 * it on the next load.
 */
describe("readExperimentWorkspace", () => {
  it("is off for a blob that armed none of the four", () => {
    expect(readExperimentWorkspace({})).toBe(false);
    expect(
      readExperimentWorkspace({
        experimentHome: false,
        experimentOrchestrator: false,
        experimentOrchestratorPerProject: false,
        experimentVoice: false,
      }),
    ).toBe(false);
  });

  it("is on when any one of the four was armed", () => {
    for (const key of [
      "experimentHome",
      "experimentOrchestrator",
      "experimentOrchestratorPerProject",
      "experimentVoice",
    ]) {
      expect(readExperimentWorkspace({ [key]: true })).toBe(true);
    }
  });

  it("derives the whole state from a settings object written before the fold", () => {
    const stored = {
      openOnLaunch: "home",
      experimentHome: true,
      experimentOrchestrator: true,
      experimentOrchestratorPerProject: false,
      experimentVoice: false,
      experimentSmartSort: true,
      smartSortBy: "activity",
      sidebarDesign: "classic",
      sidebarHarnessLogos: false,
    };
    expect(readExperimentWorkspace(stored)).toBe(true);
    // The graduated three are not inputs to the fold: the behaviour they
    // guarded is now unconditional, so their stored value decides nothing.
    expect(readExperimentWorkspace({ ...stored, experimentHome: false, experimentOrchestrator: false })).toBe(
      false,
    );
  });

  it("lets an explicit value outrank the old keys, false included", () => {
    expect(
      readExperimentWorkspace({ experimentWorkspace: false, experimentHome: true }),
    ).toBe(false);
    expect(
      readExperimentWorkspace({ experimentWorkspace: true, experimentHome: false }),
    ).toBe(true);
  });

  it("names every key a fresh save must not write back", () => {
    expect([...RETIRED_SETTINGS_KEYS].sort()).toEqual(
      [
        "experimentHome",
        "experimentOrchestrator",
        "experimentOrchestratorPerProject",
        "experimentSmartSort",
        "experimentVoice",
        "sidebarDesign",
        "sidebarHarnessLogos",
        "sidebarThreadGlow",
        "experimentInfoBox",
        "rightPanel",
        "rightPanelByProject",
        "rightPanelWidth",
      ].sort(),
    );
  });
});

/**
 * The read side of the same rule, for the flag that graduated.
 *
 * `experimentInfoBox` was a device field, so a blob written before it graduated
 * still names it, and so do the three the docked column it removed left behind.
 * A key that survives a read survives a write: `persist` spreads the state it
 * was given.
 */
describe("dropRetiredKeys", () => {
  it("takes the graduated flag and the column's three fields off a stored blob", () => {
    const blob = {
      v: 6,
      experimentInfoBox: true,
      rightPanel: "git",
      rightPanelByProject: { p: "todo" },
      rightPanelWidth: 420,
      sidebarWidth: 240,
    };
    expect(dropRetiredKeys(blob)).toEqual({ v: 6, sidebarWidth: 240 });
  });

  it("leaves a blob that names none of them alone", () => {
    expect(dropRetiredKeys({ sidebarWidth: 240 })).toEqual({ sidebarWidth: 240 });
  });

  it("is the same object, so a caller reading the fold first still can", () => {
    const blob = { experimentHome: true, experimentInfoBox: true };
    const folded = readExperimentWorkspace(blob);
    expect(folded).toBe(true);
    expect(dropRetiredKeys(blob)).toBe(blob);
    expect(blob).toEqual({});
  });
});
