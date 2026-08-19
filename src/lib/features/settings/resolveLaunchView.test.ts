import { describe, expect, it } from "vitest";
import { resolveLaunchView } from "./resolveLaunchView";

describe("resolveLaunchView", () => {
  it("returns project when the experiment is off, whatever was stored", () => {
    expect(resolveLaunchView({ experimentHome: false, openOnLaunch: "home" })).toBe(
      "project",
    );
    expect(resolveLaunchView({ experimentHome: false, openOnLaunch: "project" })).toBe(
      "project",
    );
    expect(resolveLaunchView({ experimentHome: false, openOnLaunch: "last" })).toBe(
      "project",
    );
  });

  it("honours home when the experiment is on", () => {
    expect(resolveLaunchView({ experimentHome: true, openOnLaunch: "home" })).toBe(
      "home",
    );
  });

  it("honours project when the experiment is on", () => {
    expect(resolveLaunchView({ experimentHome: true, openOnLaunch: "project" })).toBe(
      "project",
    );
  });

  it("honours last when the experiment is on", () => {
    expect(resolveLaunchView({ experimentHome: true, openOnLaunch: "last" })).toBe(
      "last",
    );
  });
});
