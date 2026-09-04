import { describe, expect, it } from "vitest";
import { composerAction } from "./keys";

describe("composerAction", () => {
  it("sends on Enter with text", () => {
    expect(composerAction({ key: "Enter", shiftKey: false }, "hello", "idle")).toEqual({
      kind: "send",
      steering: false,
    });
  });

  it("inserts a newline on Shift+Enter", () => {
    expect(composerAction({ key: "Enter", shiftKey: true }, "hello", "idle")).toEqual({
      kind: "insert",
    });
  });

  it("refuses to open an empty turn", () => {
    expect(composerAction({ key: "Enter", shiftKey: false }, "   ", "idle")).toEqual({
      kind: "insert",
    });
  });

  // The backend steers rather than queuing, so the composer has one verb for
  // both and never holds a line back.
  it("still sends during a turn, flagged as steering", () => {
    expect(composerAction({ key: "Enter", shiftKey: false }, "wait", "busy")).toEqual({
      kind: "send",
      steering: true,
    });
  });

  it("interrupts on Escape only while a turn runs", () => {
    expect(composerAction({ key: "Escape", shiftKey: false }, "", "busy")).toEqual({
      kind: "interrupt",
    });
    expect(composerAction({ key: "Escape", shiftKey: false }, "", "idle")).toEqual({
      kind: "insert",
    });
    // A question up is not a turn to interrupt: the card is what answers it.
    expect(composerAction({ key: "Escape", shiftKey: false }, "", "waiting")).toEqual({
      kind: "insert",
    });
  });

  it("passes a slash command through as ordinary text", () => {
    expect(composerAction({ key: "Enter", shiftKey: false }, "/compact", "idle")).toEqual({
      kind: "send",
      steering: false,
    });
  });

  it("leaves an IME alone", () => {
    expect(
      composerAction({ key: "Enter", shiftKey: false, composing: true }, "hi", "idle"),
    ).toEqual({ kind: "insert" });
  });
});
