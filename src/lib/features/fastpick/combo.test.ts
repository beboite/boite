import { describe, expect, it } from "vitest";
import type { FastpickModel } from "$lib/backend/types";
import {
  comboArgs,
  iconKeyForKind,
  modelLabels,
  parseCombo,
  parseFastpickAgent,
  replayCombo,
} from "./combo";

function model(id: string, label: string | null): FastpickModel {
  return { id, label, contextWindow: null, effort: [], effortDefault: null, prompts: [] };
}

describe("comboArgs", () => {
  it("names the credential only when there is one to name", () => {
    expect(comboArgs({ harness: "h", provider: "p", model: "m" })).not.toContain("--key");
    expect(comboArgs({ harness: "h", provider: "p", key: null, model: "m" })).not.toContain("--key");
    expect(comboArgs({ harness: "h", provider: "p", key: "second", model: "m" })).toEqual([
      "--harness", "h", "--provider", "p", "--model", "m",
      "--key", "p.second",
    ]);
  });

  it("names all three answers so fastpick opens no menu", () => {
    expect(comboArgs({ harness: "claude-code", provider: "acme", model: "acme-large" })).toEqual([
      "--harness",
      "claude-code",
      "--provider",
      "acme",
      "--model",
      "acme-large",
    ]);
  });

  it("leaves the prompt files out when the choice is fastpick's", () => {
    const args = comboArgs({ harness: "h", provider: "p", model: "m" });
    expect(args).not.toContain("--md");
    expect(args).not.toContain("--no-md");
  });

  it("says none out loud, since silence means the matching file", () => {
    expect(comboArgs({ harness: "h", provider: "p", model: "m", prompts: [] })).toContain("--no-md");
  });

  it("repeats --md once per file", () => {
    expect(comboArgs({ harness: "h", provider: "p", model: "m", prompts: ["a", "b"] })).toEqual([
      "--harness", "h", "--provider", "p", "--model", "m",
      "--md", "a", "--md", "b",
    ]);
  });
});

describe("parseCombo", () => {
  it("reads back what comboArgs wrote", () => {
    const combo = {
      harness: "claude-code",
      provider: "acme",
      key: null,
      model: "acme-large",
      effort: "high",
      prompts: ["acme-large"],
    };
    expect(parseCombo("fastpick", comboArgs(combo))).toEqual(combo);
  });

  it("reads back a credential too, which is what makes a shared model id unambiguous", () => {
    const combo = {
      harness: "claude-code",
      provider: "acme",
      key: "billing",
      model: "acme-large",
      effort: null,
      prompts: undefined,
    };
    expect(parseCombo("fastpick", comboArgs(combo))).toEqual(combo);
  });

  it("takes the provider from --key when nothing else named it", () => {
    expect(
      parseCombo("fastpick", ["--harness", "h", "--key", "acme.billing", "--model", "m"]),
    ).toEqual({ harness: "h", provider: "acme", key: "billing", model: "m", effort: null, prompts: undefined });
  });

  it("keeps --provider when both are written, the two being one answer", () => {
    expect(
      parseCombo("fastpick", [
        "--harness", "h", "--provider", "acme", "--key", "acme.billing", "--model", "m",
      ])?.provider,
    ).toBe("acme");
  });

  it("ignores a command that is not fastpick", () => {
    expect(parseCombo("claude", ["--harness", "h", "--provider", "p", "--model", "m"])).toBeNull();
  });

  it("recognises the launcher however the thread spells it", () => {
    const args = ["--harness", "h", "--provider", "p", "--model", "m"];
    const combo = { harness: "h", provider: "p", key: null, model: "m", effort: null, prompts: undefined };
    for (const cmd of [
      "fastpick.exe",
      "C:\\Users\\x\\.cargo\\bin\\fastpick.exe",
      "/home/x/.cargo/bin/fastpick",
      "FastPick.EXE",
    ]) {
      expect(parseCombo(cmd, args)).toEqual(combo);
    }
  });

  it("stops at the name, so a neighbour is not the launcher", () => {
    const args = ["--harness", "h", "--provider", "p", "--model", "m"];
    for (const cmd of ["myfastpick", "fastpick-shim", "notfastpick.exe"]) {
      expect(parseCombo(cmd, args)).toBeNull();
    }
  });

  it("refuses a partial combo, which still opens a menu", () => {
    expect(parseCombo("fastpick", ["--harness", "claude-code"])).toBeNull();
    expect(parseCombo("fastpick", [])).toBeNull();
  });

  it("survives a flag left dangling at the end", () => {
    expect(parseCombo("fastpick", ["--harness", "h", "--provider", "p", "--model"])).toBeNull();
  });

  it("keeps arguments meant for the agent out of the combo", () => {
    const combo = parseCombo("fastpick", [
      "--harness", "h", "--provider", "p", "--model", "m",
      "--", "-p", "hello",
    ]);
    expect(combo).toEqual({ harness: "h", provider: "p", key: null, model: "m", effort: null, prompts: undefined });
  });

  it("reads --no-md as an explicit none", () => {
    const combo = parseCombo("fastpick", [
      "--harness", "h", "--provider", "p", "--model", "m", "--no-md",
    ]);
    expect(combo?.prompts).toEqual([]);
  });
});

describe("replayCombo", () => {
  it("rebuilds the combo and drops whatever sat behind --", () => {
    const launch = replayCombo("fastpick", [
      "--harness", "claude-code", "--provider", "crof", "--model", "deepseek-v4-pro",
      "--key", "crof.work", "--effort", "high", "--md", "work",
      "--", "--resume", "old-session", "--mcp-config", "C:/stale.json",
    ]);
    expect(launch).toEqual({
      cmd: "fastpick",
      args: [
        "--harness", "claude-code", "--provider", "crof", "--model", "deepseek-v4-pro",
        "--key", "crof.work", "--effort", "high", "--md", "work",
      ],
      label: "deepseek-v4-pro · crof.work",
      iconKey: "claude",
    });
  });

  it("picks the icon from the harness, not from the binary name", () => {
    expect(replayCombo("fastpick", [
      "--harness", "pi", "--provider", "acme", "--model", "acme-large",
    ])?.iconKey).toBe("pi");
  });

  it("recognises the launcher however the thread spells it", () => {
    const args = ["--harness", "claude-code", "--provider", "p", "--model", "m"];
    expect(replayCombo("fastpick.exe", args)?.cmd).toBe("fastpick");
    expect(replayCombo("C:\\Users\\x\\.cargo\\bin\\fastpick.exe", args)?.cmd).toBe("fastpick");
  });

  it("leaves a native CLI alone, which is what the preset path is for", () => {
    expect(replayCombo("claude", ["--dangerously-skip-permissions"])).toBeNull();
    expect(replayCombo("fastpick", ["--harness", "claude-code"])).toBeNull();
  });
});

describe("parseFastpickAgent", () => {
  it("reads a three-part name as claude-code, which is what it always meant", () => {
    expect(parseFastpickAgent("fastpick:crof:crof-deepseek-v4-pro")).toEqual({
      harness: "claude-code",
      provider: "crof",
      key: null,
      model: "crof-deepseek-v4-pro",
    });
  });

  it("takes the harness when the name opens with one", () => {
    expect(parseFastpickAgent("fastpick:pi:crof:crof-deepseek-v4-pro")).toEqual({
      harness: "pi",
      provider: "crof",
      key: null,
      model: "crof-deepseek-v4-pro",
    });
  });

  it("keeps a colon in the model rather than reading it as a harness", () => {
    expect(parseFastpickAgent("fastpick:acme:some:model")).toEqual({
      harness: "claude-code",
      provider: "acme",
      key: null,
      model: "some:model",
    });
  });

  it("names one credential of a provider that holds several", () => {
    expect(parseFastpickAgent("fastpick:codex:codex-everywhere.openai:gpt-5.4")).toEqual({
      harness: "codex",
      provider: "codex-everywhere",
      key: "openai",
      model: "gpt-5.4",
    });
  });

  it("is not a fastpick name without a provider and a model", () => {
    expect(parseFastpickAgent("fastpick:crof")).toBeNull();
    expect(parseFastpickAgent("fastpick::model")).toBeNull();
    expect(parseFastpickAgent("claude")).toBeNull();
  });
});

describe("iconKeyForKind", () => {
  it("maps a harness onto the agent boite already knows", () => {
    expect(iconKeyForKind("claude-code")).toBe("claude");
    expect(iconKeyForKind("opencode")).toBe("opencode");
    expect(iconKeyForKind("codex")).toBe("codex");
    expect(iconKeyForKind("pi")).toBe("pi");
  });

  it("has no icon for a kind it has never heard of", () => {
    expect(iconKeyForKind("something-new")).toBeNull();
  });
});

describe("modelLabels", () => {
  it("keeps the label fastpick gave when it says something on its own", () => {
    const labels = modelLabels([model("acme-large", "Large"), model("acme-small", "Small")]);
    expect(labels.get("acme-large")).toBe("Large");
    expect(labels.get("acme-small")).toBe("Small");
  });

  it("falls back to the id for every model sharing a label", () => {
    const labels = modelLabels([
      model("claude-opus-5[1m]", "Opus 5"),
      model("claude-opus-5", "Opus 5"),
      model("claude-sonnet-5", "Sonnet 5"),
    ]);
    expect(labels.get("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(labels.get("claude-opus-5")).toBe("claude-opus-5");
    expect(labels.get("claude-sonnet-5")).toBe("Sonnet 5");
  });

  it("reads a missing or blank label as no label", () => {
    const labels = modelLabels([model("acme-large", null), model("acme-small", "  ")]);
    expect(labels.get("acme-large")).toBe("acme-large");
    expect(labels.get("acme-small")).toBe("acme-small");
  });

  it("does not collide a label with an id another model wears", () => {
    // The unlabelled model already reads as `acme-large`, so the labelled one has to give
    // its label up too, or the two rows read the same again.
    const labels = modelLabels([model("acme-large", null), model("acme-l", "acme-large")]);
    expect(labels.get("acme-large")).toBe("acme-large");
    expect(labels.get("acme-l")).toBe("acme-l");
  });

  it("does not collide a label with an id another model is about to fall back to", () => {
    // The first two share a label and both drop to their ids. The third's label
    // is one of those ids, spelled out by hand in the config, so it has to give
    // its label up as well or it reads exactly like the row above it.
    const labels = modelLabels([
      model("claude-opus-5[1m]", "Opus 5"),
      model("claude-opus-5", "Opus 5"),
      model("acme-o5", "claude-opus-5"),
    ]);
    expect(labels.get("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(labels.get("claude-opus-5")).toBe("claude-opus-5");
    expect(labels.get("acme-o5")).toBe("acme-o5");
  });

  it("falls back for labels a reader tells apart only by case", () => {
    const labels = modelLabels([
      model("claude-opus-5[1m]", "Opus 5"),
      model("claude-opus-5", "opus 5"),
    ]);
    expect(labels.get("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(labels.get("claude-opus-5")).toBe("claude-opus-5");
  });

  it("falls back for labels the browser collapses into the same row", () => {
    const labels = modelLabels([model("acme-large", "Opus  5"), model("acme-l", "Opus 5")]);
    expect(labels.get("acme-large")).toBe("acme-large");
    expect(labels.get("acme-l")).toBe("acme-l");
  });

  it("draws a kept label as the config wrote it, flattening only the comparison", () => {
    const labels = modelLabels([model("acme-large", "Opus  5"), model("acme-small", "Sonnet 5")]);
    expect(labels.get("acme-large")).toBe("Opus  5");
  });

  it("gives a repeated id nothing but the id, since both entries launch it", () => {
    const labels = modelLabels([model("acme-large", "Large"), model("acme-large", "Also large")]);
    expect(labels.get("acme-large")).toBe("acme-large");
  });

  it("answers nothing for an empty list", () => {
    expect(modelLabels([]).size).toBe(0);
  });
});
