import { describe, expect, it } from "vitest";
import {
  CLI_PRESETS,
  findPresetForCommand,
  hasYoloFlag,
  withYoloFlag,
  withoutYoloFlag,
} from "./cliPresets";

describe("cliPresets", () => {
  it("defines 10 presets with appropriate yolo flags", () => {
    expect(CLI_PRESETS.length).toBe(10);
    const claude = CLI_PRESETS.find((p) => p.id === "claude");
    expect(claude?.yoloFlag).toBe("--dangerously-skip-permissions");

    const agy = CLI_PRESETS.find((p) => p.id === "antigravity");
    expect(agy?.yoloFlag).toBe("--dangerously-skip-permissions");

    const codex = CLI_PRESETS.find((p) => p.id === "codex");
    expect(codex?.yoloFlag).toBe("--yolo");

    const opencode = CLI_PRESETS.find((p) => p.id === "opencode");
    expect(opencode?.yoloFlag).toBe("--auto");

    const cursor = CLI_PRESETS.find((p) => p.id === "cursor");
    expect(cursor?.yoloFlag).toBe("--force");

    const grok = CLI_PRESETS.find((p) => p.id === "grok");
    expect(grok?.yoloFlag).toBe("--yolo");

    const hermes = CLI_PRESETS.find((p) => p.id === "hermes");
    expect(hermes?.yoloFlag).toBe("--yolo");

    const copilot = CLI_PRESETS.find((p) => p.id === "copilot");
    expect(copilot?.yoloFlag).toBe("-- --yolo");

    const muse = CLI_PRESETS.find((p) => p.id === "muse");
    expect(muse?.yoloFlag).toBe("--yolo");

    const pi = CLI_PRESETS.find((p) => p.id === "pi");
    expect(pi?.yoloFlag).toBeUndefined();
  });

  describe("findPresetForCommand", () => {
    it("matches standard preset commands", () => {
      expect(findPresetForCommand("claude")?.id).toBe("claude");
      expect(findPresetForCommand("claude --dangerously-skip-permissions")?.id).toBe("claude");
      expect(findPresetForCommand("agy -i 'test'")?.id).toBe("antigravity");
      expect(findPresetForCommand("codex --no-alt-screen --yolo")?.id).toBe("codex");
      expect(findPresetForCommand("copilot -- --yolo")?.id).toBe("copilot");
      // The gh extension is a different product from the standalone CLI this
      // preset names.
      expect(findPresetForCommand("gh copilot -- --yolo")).toBeNull();
    });

    it("returns null for unknown command", () => {
      expect(findPresetForCommand("")).toBeNull();
      expect(findPresetForCommand("unknown-tool --flag")).toBeNull();
    });
  });

  describe("hasYoloFlag", () => {
    it("detects regular flags", () => {
      expect(hasYoloFlag("claude --dangerously-skip-permissions", "--dangerously-skip-permissions")).toBe(true);
      expect(hasYoloFlag("claude", "--dangerously-skip-permissions")).toBe(false);
      expect(hasYoloFlag("codex --no-alt-screen --yolo", "--yolo")).toBe(true);
      expect(hasYoloFlag("codex --no-alt-screen", "--yolo")).toBe(false);
    });

    it("detects copilot dashed flag", () => {
      expect(hasYoloFlag("copilot -- --yolo", "-- --yolo")).toBe(true);
      expect(hasYoloFlag("copilot", "-- --yolo")).toBe(false);
    });
  });

  describe("withYoloFlag & withoutYoloFlag", () => {
    it("appends flag when missing and strips when present", () => {
      const initial = "claude";
      const withFlag = withYoloFlag(initial, "--dangerously-skip-permissions");
      expect(withFlag).toBe("claude --dangerously-skip-permissions");
      expect(withYoloFlag(withFlag, "--dangerously-skip-permissions")).toBe("claude --dangerously-skip-permissions");

      const stripped = withoutYoloFlag(withFlag, "--dangerously-skip-permissions");
      expect(stripped).toBe("claude");
    });

    it("handles copilot flag correctly", () => {
      const initial = "copilot";
      const withFlag = withYoloFlag(initial, "-- --yolo");
      expect(withFlag).toBe("copilot -- --yolo");
      expect(withoutYoloFlag(withFlag, "-- --yolo")).toBe("copilot");
    });
  });
});
