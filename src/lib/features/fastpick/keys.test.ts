import { describe, expect, it } from "vitest";
import type { FastpickProvider } from "$lib/backend/types";
import { keyForModel, keyLabel, keysForHarness, missingKeyFile, providerKeys } from "./keys";

/** Schema 3: the credentials are the provider's, and each carries its own key file. */
const twoKeys: FastpickProvider = {
  id: "acme",
  name: "Acme",
  group: null,
  keys: [
    { id: "anthropic", label: "anthropic  ◈ relay", needsKey: true, keyPresent: true },
    { id: "xai", label: null, needsKey: true, keyPresent: false },
  ],
};

/** Schema 2 and below, where a provider was one credential and said so itself. */
const legacy: FastpickProvider = {
  id: "old",
  name: "Old",
  group: null,
  needsKey: true,
  keyPresent: false,
  proxyPort: 8317,
  harnesses: { cc: { baseUrl: "http://127.0.0.1:8317" } },
};

describe("providerKeys", () => {
  it("hands back the keys a current fastpick lists", () => {
    expect(providerKeys(twoKeys).map((k) => k.id)).toEqual(["anthropic", "xai"]);
  });

  it("folds the older shape into the one key it described", () => {
    const [only] = providerKeys(legacy);
    expect(only.id).toBe("old");
    expect(only.needsKey).toBe(true);
    expect(only.keyPresent).toBe(false);
    expect(only.proxyPort).toBe(8317);
    expect(only.harnesses?.cc.baseUrl).toBe("http://127.0.0.1:8317");
  });

  it("answers nothing for a provider the listing has not landed for", () => {
    expect(providerKeys(null)).toEqual([]);
  });
});

describe("keyForModel", () => {
  it("takes the credential the model came from", () => {
    expect(keyForModel(providerKeys(twoKeys), { key: "xai" })?.id).toBe("xai");
  });

  it("takes the first when the model names none, which is every model before schema 3", () => {
    expect(keyForModel(providerKeys(twoKeys), { key: null })?.id).toBe("anthropic");
    expect(keyForModel(providerKeys(twoKeys), null)?.id).toBe("anthropic");
  });

  it("takes the first when the model names one the config no longer has", () => {
    expect(keyForModel(providerKeys(twoKeys), { key: "gone" })?.id).toBe("anthropic");
  });
});

describe("keysForHarness", () => {
  // The shape that made this necessary: one provider whose third credential reaches
  // another agent entirely, and whose models cannot launch on this one.
  const mixed: FastpickProvider = {
    id: "everywhere",
    name: "Everywhere",
    group: null,
    keys: [
      { id: "anthropic", label: null, needsKey: true, keyPresent: true, harnesses: { "claude-code": {}, pi: {} } },
      { id: "xai", label: null, needsKey: true, keyPresent: true, harnesses: { "claude-code": {}, pi: {} } },
      { id: "openai", label: null, needsKey: true, keyPresent: true, harnesses: { "claude-code": {}, codex: {} } },
    ],
  };

  it("keeps only the credentials wired to that harness", () => {
    expect(keysForHarness(mixed, "pi").map((k) => k.id)).toEqual(["anthropic", "xai"]);
    expect(keysForHarness(mixed, "codex").map((k) => k.id)).toEqual(["openai"]);
    expect(keysForHarness(mixed, "claude-code")).toHaveLength(3);
  });

  it("keeps a credential that declares no bindings, an older fastpick saying less", () => {
    expect(keysForHarness(twoKeys, "claude-code")).toHaveLength(2);
    expect(keysForHarness(legacy, "claude-code")).toHaveLength(1);
  });

  it("hands back everything when no harness is picked yet", () => {
    expect(keysForHarness(mixed, null)).toHaveLength(3);
  });
});

describe("missingKeyFile", () => {
  it("marks a provider as soon as one of its credentials has no file", () => {
    expect(missingKeyFile(providerKeys(twoKeys))).toBe(true);
    expect(missingKeyFile(providerKeys(legacy))).toBe(true);
  });

  it("says nothing about a credential that wants no file", () => {
    expect(
      missingKeyFile([{ id: "native", label: null, needsKey: false, keyPresent: false }]),
    ).toBe(false);
  });
});

describe("keyLabel", () => {
  it("draws fastpick's label, and the id when there is none to draw", () => {
    expect(keyLabel(twoKeys.keys![0])).toBe("anthropic  ◈ relay");
    expect(keyLabel(twoKeys.keys![1])).toBe("xai");
  });
});
