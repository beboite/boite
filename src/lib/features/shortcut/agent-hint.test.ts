import { describe, expect, it } from "vitest";
import { shortcutAgentHint } from "./agent-hint";

describe("shortcutAgentHint", () => {
  it("names a preset from its executable", () => {
    expect(shortcutAgentHint("claude")).toBe("Claude");
    expect(shortcutAgentHint("codex --no-alt-screen")).toBe("Codex");
    expect(shortcutAgentHint("grok --yolo")).toBe("Grok");
  });

  it("unwraps a PowerShell wrapper so the inner agent is what the row shows", () => {
    expect(shortcutAgentHint("pwsh -NoLogo -NoProfile -Command claude")).toBe("Claude");
    expect(
      shortcutAgentHint('pwsh -NoLogo -NoProfile -Command "claude --dangerously-skip-permissions"'),
    ).toBe("Claude");
  });

  it("keeps a bare wrapper as the shell stem rather than its flags", () => {
    expect(shortcutAgentHint("pwsh -NoLogo -NoProfile")).toBe("pwsh");
  });

  it("uses fastpick's parseCombo when the command is a combo", () => {
    expect(
      shortcutAgentHint(
        "fastpick --harness claude-code --provider anthropic --model claude-opus-5",
      ),
    ).toBe("claude-opus-5 · anthropic");
  });

  it("unwraps a wrapper around a fastpick combo", () => {
    expect(
      shortcutAgentHint(
        'pwsh -NoLogo -NoProfile -Command "fastpick --harness claude-code --provider anthropic --model claude-opus-5"',
      ),
    ).toBe("claude-opus-5 · anthropic");
  });
});
