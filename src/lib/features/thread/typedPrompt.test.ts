import { describe, expect, it } from "vitest";
import {
  claimTypedPrompt,
  stageTypedPrompt,
  typedPromptPayload,
} from "./typedPrompt";

describe("typedPrompt", () => {
  it("collapses the briefing to one line so a newline cannot submit early", () => {
    stageTypedPrompt("t1", "read the\n docs\r\nplease");
    expect(claimTypedPrompt("t1")).toEqual({
      text: "read the docs please",
      submit: false,
    });
  });

  it("is one-shot, so a relaunch cannot re-brief", () => {
    stageTypedPrompt("t2", "go", true);
    expect(claimTypedPrompt("t2")?.submit).toBe(true);
    expect(claimTypedPrompt("t2")).toBeNull();
  });

  it("appends CR only when the spawn path asked to submit", () => {
    expect(typedPromptPayload({ text: "do the thing", submit: false })).toBe("do the thing");
    expect(typedPromptPayload({ text: "do the thing", submit: true })).toBe("do the thing\r");
  });
});
