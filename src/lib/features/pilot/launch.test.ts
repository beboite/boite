import { describe, expect, it } from "vitest";
import { chatAvailable, chatLaunchFor, driverOfCommand, optionsJson } from "./launch";
import type { PilotCatalog } from "./types";

const CATALOG: PilotCatalog = {
  drivers: [{ id: "claude", capabilities: null, models: [] }],
  instances: [],
};

describe("driverOfCommand", () => {
  it("names the preset behind a plain command", () => {
    expect(driverOfCommand("claude")).toBe("claude");
    expect(driverOfCommand("codex --no-alt-screen")).toBe("codex");
  });

  it("peels a shell wrapper", () => {
    expect(driverOfCommand("pwsh -NoLogo -Command claude")).toBe("claude");
  });

  it("reads a fastpick harness as the driver", () => {
    expect(
      driverOfCommand("fastpick --harness claude --provider xcode --model opus-5"),
    ).toBe("claude");
  });

  it("answers nothing for a bare shell", () => {
    expect(driverOfCommand("pwsh")).toBeNull();
    expect(driverOfCommand("")).toBeNull();
  });
});

describe("chatAvailable", () => {
  it("follows the catalog rather than a list of its own", () => {
    expect(chatAvailable(CATALOG, "claude")).toBe(true);
    expect(chatAvailable(CATALOG, "grok")).toBe(false);
  });

  it("says no while the catalog has not answered", () => {
    expect(chatAvailable(null, "claude")).toBe(false);
  });
});

describe("chatLaunchFor", () => {
  it("writes a native instance for a plain preset", () => {
    expect(chatLaunchFor("claude")).toEqual({
      driver: "claude",
      instance: { type: "native" },
      model: null,
      mode: "ask",
    });
  });

  // The same yolo choice the terminal launch makes: the flag is on the
  // shortcut's own command, so one shortcut means one thing in both runtimes.
  it("takes yolo off the preset's own flag", () => {
    expect(chatLaunchFor("claude --dangerously-skip-permissions")?.mode).toBe("yolo");
  });

  it("writes the fastpick route when the launch carries a combo", () => {
    expect(
      chatLaunchFor("fastpick --harness claude --provider xcode --model opus-5"),
    ).toEqual({
      driver: "claude",
      instance: { type: "fastpick", provider: "xcode", model: "opus-5" },
      model: "opus-5",
      mode: "ask",
    });
  });

  it("has nothing to say about a shell", () => {
    expect(chatLaunchFor("pwsh")).toBeNull();
  });
});

describe("optionsJson", () => {
  it("is the shape boite_pilot::Options deserialises", () => {
    expect(JSON.parse(optionsJson("yolo"))).toEqual({ effort: null, mode: "yolo" });
  });
});
