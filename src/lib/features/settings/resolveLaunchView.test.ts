import { describe, expect, it } from "vitest";
import { resolveLaunchView } from "./resolveLaunchView";
import type { OpenOnLaunch } from "$lib/types";
import type { HomeAvailabilitySettings } from "./homeAvailable";

const OFF: HomeAvailabilitySettings = {
  experimentHome: false,
  experimentOrchestrator: false,
  experimentOrchestratorPerProject: false,
  orchestratorAgent: null,
  orchestratorByProject: {},
};

function at(open: OpenOnLaunch, over: Partial<HomeAvailabilitySettings> = {}) {
  return { ...OFF, ...over, openOnLaunch: open };
}

describe("resolveLaunchView", () => {
  it("returns project when nothing reaches home, whatever was stored", () => {
    expect(resolveLaunchView(at("home"))).toBe("project");
    expect(resolveLaunchView(at("project"))).toBe("project");
    expect(resolveLaunchView(at("last"))).toBe("project");
  });

  it("honours home when the experiment is on", () => {
    expect(resolveLaunchView(at("home", { experimentHome: true }))).toBe("home");
  });

  it("honours home when the orchestrator alone is armed", () => {
    expect(
      resolveLaunchView(
        at("home", { experimentOrchestrator: true, orchestratorAgent: "claude" }),
      ),
    ).toBe("home");
  });

  it("still returns project when the orchestrator is armed without an agent", () => {
    expect(resolveLaunchView(at("home", { experimentOrchestrator: true }))).toBe(
      "project",
    );
  });

  it("honours project when the experiment is on", () => {
    expect(resolveLaunchView(at("project", { experimentHome: true }))).toBe("project");
  });

  it("honours last when the experiment is on", () => {
    expect(resolveLaunchView(at("last", { experimentHome: true }))).toBe("last");
  });
});
