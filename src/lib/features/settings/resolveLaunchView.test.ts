import { describe, expect, it } from "vitest";
import { resolveLaunchView } from "./resolveLaunchView";
import type { OpenOnLaunch } from "$lib/types";
import type { HomeAvailabilitySettings } from "./homeAvailable";

const OFF: HomeAvailabilitySettings = { experimentWorkspace: false };

function at(open: OpenOnLaunch, over: Partial<HomeAvailabilitySettings> = {}) {
  return { ...OFF, ...over, openOnLaunch: open };
}

describe("resolveLaunchView", () => {
  it("returns project when nothing reaches home, whatever was stored", () => {
    expect(resolveLaunchView(at("home"))).toBe("project");
    expect(resolveLaunchView(at("project"))).toBe("project");
    expect(resolveLaunchView(at("last"))).toBe("project");
  });

  it("honours home when the workspace experiment is on", () => {
    expect(resolveLaunchView(at("home", { experimentWorkspace: true }))).toBe("home");
  });

  it("honours project when the experiment is on", () => {
    expect(resolveLaunchView(at("project", { experimentWorkspace: true }))).toBe(
      "project",
    );
  });

  it("honours last when the experiment is on", () => {
    expect(resolveLaunchView(at("last", { experimentWorkspace: true }))).toBe("last");
  });
});
