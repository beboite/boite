import { describe, expect, it } from "vitest";
import { JUMP_SLOTS, jumpDigit } from "./held.svelte";

describe("which row a digit reaches", () => {
  it("numbers from one, not from zero", () => {
    expect(jumpDigit(0)).toBe(1);
    expect(jumpDigit(8)).toBe(9);
  });

  /**
   * Ctrl+0 is reset zoom, so there is no tenth slot to give away. A row past
   * the ninth wears nothing rather than a number that does nothing, which is
   * the whole failure this hint exists to fix.
   */
  it("stops at the ninth", () => {
    expect(jumpDigit(JUMP_SLOTS)).toBeNull();
    expect(jumpDigit(40)).toBeNull();
  });
});
