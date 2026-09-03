import { describe, expect, it } from "vitest";
import { orchestratorEnabledFor } from "./orchestratorEnabledFor";

const armed = {
  experimentWorkspace: true,
  orchestratorAgent: "claude",
  orchestratorByProject: {} as Record<string, "on" | "off">,
};

describe("orchestratorEnabledFor", () => {
  it("is off everywhere when the experiment is off", () => {
    const s = { ...armed, experimentWorkspace: false };
    expect(orchestratorEnabledFor(s, null)).toBe(false);
    expect(orchestratorEnabledFor(s, "p1")).toBe(false);
  });

  it("is off everywhere when no agent is chosen", () => {
    const s = { ...armed, orchestratorAgent: null };
    expect(orchestratorEnabledFor(s, null)).toBe(false);
    expect(orchestratorEnabledFor(s, "p1")).toBe(false);
  });

  it("is on for every project when armed with an agent", () => {
    expect(orchestratorEnabledFor(armed, null)).toBe(true);
    expect(orchestratorEnabledFor(armed, "p1")).toBe(true);
  });

  it("honours per-project overrides", () => {
    const s = {
      ...armed,
      orchestratorByProject: { p1: "off" as const, p2: "on" as const },
    };
    expect(orchestratorEnabledFor(s, "p1")).toBe(false);
    expect(orchestratorEnabledFor(s, "p2")).toBe(true);
    // A project with no override falls through to the global answer.
    expect(orchestratorEnabledFor(s, "p3")).toBe(true);
    // The workspace-wide question never consults an override.
    expect(orchestratorEnabledFor(s, null)).toBe(true);
  });
});
