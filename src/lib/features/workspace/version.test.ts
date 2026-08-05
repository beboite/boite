import { describe, expect, it } from "vitest";
import { compareVersions, isBehind } from "./version";

describe("compareVersions", () => {
  it("orders releases by their numbers, not by their text", () => {
    expect(compareVersions("1.0.9", "1.0.10")).toBe(-1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.2", "1.0.2")).toBe(0);
  });

  it("reads a missing segment as a zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });

  it("puts a pre-release before the release it leads to", () => {
    expect(compareVersions("1.0.2-rc.1", "1.0.2")).toBe(-1);
    expect(compareVersions("1.0.2", "1.0.2-rc.1")).toBe(1);
    expect(compareVersions("1.0.3-rc.1", "1.0.2")).toBe(1);
  });

  it("ignores a leading v and build metadata", () => {
    expect(compareVersions("v1.0.3", "1.0.3")).toBe(0);
    expect(compareVersions("1.0.3+abc", "1.0.3")).toBe(0);
  });

  // A badge that says a healthy boite is behind is worse than no badge, so
  // anything unreadable answers "same" and draws nothing.
  it("answers same when either side cannot be read", () => {
    expect(compareVersions("", "1.0.2")).toBe(0);
    expect(compareVersions("nightly", "1.0.2")).toBe(0);
    expect(compareVersions("1.0.2", "unknown")).toBe(0);
  });
});

describe("isBehind", () => {
  it("says nothing about a boite whose version was never seen", () => {
    expect(isBehind(null, "1.0.2")).toBe(false);
    expect(isBehind("", "1.0.2")).toBe(false);
  });

  it("compares a boite against the build asking", () => {
    expect(isBehind("1.0.1", "1.0.2")).toBe(true);
    expect(isBehind("1.0.2", "1.0.2")).toBe(false);
    expect(isBehind("1.1.0", "1.0.2")).toBe(false);
  });
});
