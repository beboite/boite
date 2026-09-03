import { describe, expect, it } from "vitest";
import {
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
      ].sort(),
    );
  });
});
