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

  it("opens the model chip on Ctrl+M, and on Cmd+M for a mac", () => {
    expect(composerAction({ key: "m", shiftKey: false, ctrlKey: true }, "", "idle")).toEqual({
      kind: "picker",
    });
    expect(composerAction({ key: "M", shiftKey: false, metaKey: true }, "", "idle")).toEqual({
      kind: "picker",
    });
    // Without the modifier it is a letter.
    expect(composerAction({ key: "m", shiftKey: false }, "", "idle")).toEqual({
      kind: "insert",
    });
  });

  it("recalls the last prompt on Ctrl+Up", () => {
    expect(
      composerAction({ key: "ArrowUp", shiftKey: false, ctrlKey: true }, "", "idle"),
    ).toEqual({ kind: "recall" });
    // A bare arrow is a caret move and stays one.
    expect(composerAction({ key: "ArrowUp", shiftKey: false }, "", "idle")).toEqual({
      kind: "insert",
    });
  });

  // With the hint row up, Tab and the arrows belong to the list. Enter still
  // sends: the text goes to the driver either way.
  it("gives Tab and the arrows to the slash hint while it is up", () => {
    expect(composerAction({ key: "Tab", shiftKey: false }, "/re", "idle", true)).toEqual({
      kind: "hint",
    });
    expect(composerAction({ key: "Tab", shiftKey: true }, "/re", "idle", true)).toEqual({
      kind: "hintMove",
      move: -1,
    });
    expect(composerAction({ key: "ArrowDown", shiftKey: false }, "/re", "idle", true)).toEqual({
      kind: "hintMove",
      move: 1,
    });
    expect(composerAction({ key: "Enter", shiftKey: false }, "/re", "idle", true)).toEqual({
      kind: "send",
      steering: false,
    });
    expect(composerAction({ key: "Tab", shiftKey: false }, "/re", "idle", false)).toEqual({
      kind: "insert",
    });
  });
});
