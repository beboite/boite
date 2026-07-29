import { describe, expect, it } from "vitest";
import { ACCENT_COLOR, CLAUDE_BAR_COLOR, isLocalUrl, modelAccent, modelFamily } from "./accent";
import type { FastpickProvider } from "$lib/backend/types";

function provider(patch: Partial<FastpickProvider> = {}): FastpickProvider {
  return {
    id: "acme",
    name: "Acme",
    group: null,
    needsKey: true,
    keyPresent: true,
    ...patch,
  };
}

const combo = { harness: "cc", provider: "acme", model: "claude-sonnet-4" };

describe("modelFamily", () => {
  it("reads the family off the model id", () => {
    expect(modelFamily("claude-opus-4-1")).toBe("claude");
    expect(modelFamily("anthropic/claude-3.5-haiku")).toBe("claude");
    expect(modelFamily("gpt-5")).toBe("gpt");
    expect(modelFamily("o3-mini")).toBe("gpt");
  });

  it("says other rather than guessing", () => {
    expect(modelFamily("qwen3-coder-480b")).toBe("other");
    expect(modelFamily("")).toBe("other");
  });
});

describe("isLocalUrl", () => {
  it("knows the addresses a local runner binds to", () => {
    expect(isLocalUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLocalUrl("http://[::1]:8080")).toBe(true);
    expect(isLocalUrl("http://box.local:8080")).toBe(true);
  });

  it("is false for anything remote, and for anything unparseable", () => {
    expect(isLocalUrl("https://api.acme.com/v1")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });
});

describe("modelAccent", () => {
  it("leaves the stock agent alone: no baseUrl is the harness's own endpoint", () => {
    const p = provider({ harnesses: { cc: { baseUrl: null } } });
    expect(modelAccent(combo, p)).toBe("native");
    expect(ACCENT_COLOR.native).toBeNull();
  });

  it("marks an endpoint running on this machine", () => {
    const p = provider({ harnesses: { cc: { baseUrl: "http://localhost:11434/v1" } } });
    expect(modelAccent({ ...combo, model: "qwen3" }, p)).toBe("local");
  });

  it("tints a Claude served by someone else, which the icon cannot say", () => {
    const p = provider({ harnesses: { cc: { baseUrl: "https://api.acme.com" } } });
    expect(modelAccent(combo, p)).toBe("claude");
  });

  it("does not call a proxied provider local: the proxy listens here, the model does not", () => {
    const p = provider({
      proxyPort: 8317,
      harnesses: { cc: { baseUrl: "http://127.0.0.1:8317" } },
    });
    expect(modelAccent({ ...combo, model: "gpt-5" }, p)).toBe("gpt");
  });

  it("falls back to the model id when the listing has not landed yet", () => {
    expect(modelAccent(combo)).toBe("claude");
    expect(modelAccent({ ...combo, model: "gpt-5" }, null)).toBe("gpt");
  });

  it("falls back too when the provider is listed but not wired to this harness", () => {
    const p = provider({ harnesses: { other: { baseUrl: null } } });
    expect(modelAccent(combo, p)).toBe("claude");
  });
});

describe("CLAUDE_BAR_COLOR", () => {
  it("names a colour Claude Code's own /color accepts", () => {
    const accepted = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
    for (const [accent, colour] of Object.entries(CLAUDE_BAR_COLOR)) {
      if (colour !== null) expect(accepted, accent).toContain(colour);
    }
  });

  it("says nothing for the stock endpoint, leaving the user's own colour alone", () => {
    expect(CLAUDE_BAR_COLOR.native).toBeNull();
  });

  it("gives every tinted accent a colour, so the bar never disagrees with the icon", () => {
    expect(CLAUDE_BAR_COLOR.claude).toBe("yellow");
    expect(CLAUDE_BAR_COLOR.local).toBe("green");
    // That list has no white, so the GPT tint is the nearest cold colour rather than none.
    expect(CLAUDE_BAR_COLOR.gpt).toBe("cyan");
    expect(CLAUDE_BAR_COLOR.other).toBe("purple");
  });
});
