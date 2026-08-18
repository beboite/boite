import { describe, expect, it } from "vitest";
import { isSampledSound, pickCrack } from "./crack";

describe("pickCrack", () => {
  it("never repeats the last slice when there is another", () => {
    expect(pickCrack(2, 6, 2 / 6)).toBe(3);
    expect(pickCrack(5, 6, 0.99)).toBe(0);
  });

  it("keeps a first crack on the roll", () => {
    expect(pickCrack(null, 6, 0)).toBe(0);
    expect(pickCrack(null, 6, 0.5)).toBe(3);
  });

  it("stays on the only slice", () => {
    expect(pickCrack(0, 1, 0.9)).toBe(0);
  });
});

describe("isSampledSound", () => {
  it("treats the old meme name as the sprite", () => {
    expect(isSampledSound("sampled")).toBe(true);
    expect(isSampledSound("meme")).toBe(true);
    expect(isSampledSound("synth")).toBe(false);
  });
});
