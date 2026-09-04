import { describe, expect, it } from "vitest";
import { answerFor, instancesOf, isAlwaysAllow, switchOutcome } from "./selection";
import type { PilotCapabilities, PilotInstanceEntry, PilotRequestOption } from "./types";

const IN_SESSION: PilotCapabilities = {
  model_switch: "in_session",
  rollback: false,
  modes: ["ask", "yolo"],
  interrupt: true,
};

describe("switchOutcome", () => {
  it("switches in place on the same instance", () => {
    const out = switchOutcome(
      { driver: "claude", instance: "native" },
      { driver: "claude", instance: "native" },
      IN_SESSION,
    );
    expect(out).toEqual({ kind: "in_session", key: "pilot.switchInPlace", enabled: true });
  });

  it("restarts on another instance of the same driver", () => {
    const out = switchOutcome(
      { driver: "claude", instance: "native" },
      { driver: "claude", instance: "fastpick:xcode:opus" },
      IN_SESSION,
    );
    expect(out.kind).toBe("restart");
    expect(out.enabled).toBe(true);
  });

  it("says later, and refuses, for another driver", () => {
    const out = switchOutcome(
      { driver: "claude", instance: "native" },
      { driver: "codex", instance: "native" },
      IN_SESSION,
    );
    expect(out).toEqual({ kind: "unsupported", key: "pilot.switchLater", enabled: false });
  });

  it("restarts even in place when the driver only knows how to restart", () => {
    const out = switchOutcome(
      { driver: "codex", instance: "native" },
      { driver: "codex", instance: "native" },
      { ...IN_SESSION, model_switch: "restart" },
    );
    expect(out.kind).toBe("restart");
  });

  it("refuses when the driver declares no switch at all", () => {
    const out = switchOutcome(
      { driver: "claude", instance: "native" },
      { driver: "claude", instance: "native" },
      { ...IN_SESSION, model_switch: "unsupported" },
    );
    expect(out.enabled).toBe(false);
  });

  // A thread that has not named its instance yet has nothing to differ from,
  // so the first pick is not a restart.
  it("treats an unknown current instance as the same one", () => {
    const out = switchOutcome(
      { driver: "claude", instance: null },
      { driver: "claude", instance: "native" },
      IN_SESSION,
    );
    expect(out.kind).toBe("in_session");
  });
});

describe("instancesOf", () => {
  const rows: PilotInstanceEntry[] = [
    { name: "native", driver: "claude", kind: "native", label: "Claude" },
    { name: "fastpick:x:y", driver: "claude", kind: "fastpick", label: "x / y" },
    { name: "native", driver: "codex", kind: "native", label: "Codex" },
  ];
  it("keeps one driver's accounts", () => {
    expect(instancesOf(rows, "claude").map((r) => r.name)).toEqual([
      "native",
      "fastpick:x:y",
    ]);
  });
});

describe("answerFor", () => {
  const options: PilotRequestOption[] = [
    { value: "allow", label: "Allow" },
    { value: "allow_always", label: "Always allow" },
    { value: "deny", label: "Refuse" },
  ];

  it("sends the driver's own value back", () => {
    expect(answerFor(options, "allow_always")).toBe("allow_always");
  });

  it("refuses a value the driver never offered", () => {
    expect(answerFor(options, "run_anyway")).toBeNull();
  });

  it("has nothing to send when the request offered nothing", () => {
    expect(answerFor([], "allow")).toBeNull();
    expect(answerFor(undefined, "allow")).toBeNull();
  });
});

describe("isAlwaysAllow", () => {
  it("reads the value, not the label", () => {
    expect(isAlwaysAllow("allow_always")).toBe(true);
    expect(isAlwaysAllow("allow")).toBe(false);
  });
});
