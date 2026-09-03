import { describe, expect, it } from "vitest";
import {
  INFO_BOX_GUTTER_PX,
  INFO_BOX_LOG,
  INFO_BOX_POPOVER_PX,
  INFO_BOX_ROW_PX,
  infoBoxInset,
  popoverLeft,
} from "./strip";

describe("info box strip", () => {
  it("takes its row from the terminal only when it is drawn", () => {
    expect(infoBoxInset(true)).toBe(INFO_BOX_ROW_PX);
    expect(infoBoxInset(false)).toBe(0);
  });

  it("keeps the row to one line", () => {
    expect(INFO_BOX_ROW_PX).toBe(32);
  });

  it("lists ten commits, where the hover listed six", () => {
    expect(INFO_BOX_LOG).toBe(10);
  });

  it("aligns the popover on its trigger while it fits", () => {
    expect(popoverLeft(1000, INFO_BOX_POPOVER_PX, 400)).toBe(400);
    expect(popoverLeft(1000, INFO_BOX_POPOVER_PX, 20)).toBe(20);
  });

  it("pushes a popover that would leave the column back inside it", () => {
    expect(popoverLeft(1000, INFO_BOX_POPOVER_PX, 900)).toBe(668);
    expect(popoverLeft(1000, INFO_BOX_POPOVER_PX, -50)).toBe(INFO_BOX_GUTTER_PX);
  });

  it("pins a popover wider than its column to the left gutter", () => {
    expect(popoverLeft(300, INFO_BOX_POPOVER_PX, 200)).toBe(INFO_BOX_GUTTER_PX);
    expect(popoverLeft(0, INFO_BOX_POPOVER_PX, 0)).toBe(INFO_BOX_GUTTER_PX);
  });

  it("honours a gutter the caller passes", () => {
    expect(popoverLeft(1000, 320, 900, 40)).toBe(640);
    expect(popoverLeft(1000, 320, 0, 40)).toBe(40);
  });
});
