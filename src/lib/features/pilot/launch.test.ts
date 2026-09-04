import { describe, expect, it } from "vitest";
import {
  chatAvailable,
  chatLaunchFor,
  chatSpawnDecision,
  driverOfCommand,
  driverOfHarness,
  optionsJson,
} from "./launch";
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

describe("driverOfHarness", () => {
  // fastpick names the harness after the program, the catalog names the driver
  // after the wire. Without the mapping every fastpick route in the menu asked
  // for a driver called `claude-code` and had its Chat button greyed.
  it("reads the claude-code harness as the claude driver", () => {
    expect(driverOfHarness("claude-code")).toBe("claude");
    expect(driverOfCommand("fastpick --harness claude-code --provider crof --model opus")).toBe(
      "claude",
    );
  });

  it("leaves a harness already named after its wire alone", () => {
    expect(driverOfHarness("codex")).toBe("codex");
  });
});

describe("chatSpawnDecision", () => {
  const chat = (over: Partial<Parameters<typeof chatSpawnDecision>[0]> = {}) =>
    chatSpawnDecision({
      runtime: "pilot",
      cmd: "claude",
      args: [],
      agent: "claude",
      catalog: CATALOG,
      experiment: true,
      ...over,
    });

  it("leaves every other runtime on the terminal path", () => {
    expect(chat({ runtime: "terminal" })).toEqual({ kind: "terminal" });
    expect(chat({ runtime: null })).toEqual({ kind: "terminal" });
  });

  it("writes the five columns off the worker's own argv", () => {
    const decided = chat({
      cmd: "fastpick",
      args: ["--harness", "claude-code", "--provider", "crof", "--model", "opus-5"],
    });
    expect(decided).toEqual({
      kind: "chat",
      launch: {
        driver: "claude",
        instance: { type: "fastpick", provider: "crof", model: "opus-5" },
        model: "opus-5",
        mode: "ask",
      },
    });
  });

  // The unattended flags are added before the decision, so the mode a spawned
  // worker runs on is the one its own command line asked for.
  it("takes the mode off the yolo flag the spawn added", () => {
    const decided = chat({ args: ["--dangerously-skip-permissions"] });
    expect(decided.kind === "chat" && decided.launch.mode).toBe("yolo");
  });

  it("refuses an agent no driver answers for, and says what to ask instead", () => {
    const decided = chat({ cmd: "grok", agent: "grok" });
    expect(decided.kind).toBe("refused");
    expect(decided.kind === "refused" && decided.reason).toContain("terminal");
  });

  it("refuses while the experiment is off rather than opening a pane nobody draws", () => {
    expect(chat({ experiment: false }).kind).toBe("refused");
  });

  it("refuses while the catalog has not answered", () => {
    expect(chat({ catalog: null }).kind).toBe("refused");
  });
});

describe("optionsJson", () => {
  it("is the shape boite_pilot::Options deserialises", () => {
    expect(JSON.parse(optionsJson("yolo"))).toEqual({ effort: null, mode: "yolo" });
  });
});
