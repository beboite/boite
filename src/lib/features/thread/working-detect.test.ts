import { describe, expect, it } from "vitest";
import { detectWorkingOnScreen, LIVE_ROW_COUNT } from "./working-detect";

// Claude's idle bottom: prompt box plus the shortcut hint. Whatever it said last
// sits above that, which is the one row of transcript the window can reach.
const CLAUDE_IDLE = [
  "╭──────────────────────────────────────╮",
  "│ >                                    │",
  "╰──────────────────────────────────────╯",
  "  ? for shortcuts            ⏵⏵ accept edits on",
];

// Mid-turn: the spinner line rides above the same box.
const CLAUDE_WORKING = [
  "✻ Baking… (12s · ↓ 1.4k tokens · esc to interrupt)",
  ...CLAUDE_IDLE,
];

describe("detectWorkingOnScreen", () => {
  it("reads claude's footer as working and its absence as done", () => {
    expect(detectWorkingOnScreen(CLAUDE_WORKING, "claude")).toBe(true);
    expect(detectWorkingOnScreen(CLAUDE_IDLE, "claude")).toBe(false);
  });

  it("ignores the transcript above the live rows", () => {
    // The regression the byte-buffer detector had: this text stayed in the
    // rolling window and every later byte re-matched it, so a finished thread
    // read as working until something flushed it.
    const scrolled = [
      "● Bash(cargo test)",
      "✻ Thinking… (4s · esc to interrupt)",
      "● Done. 42 tests passed.",
      ...CLAUDE_IDLE,
    ];
    expect(detectWorkingOnScreen(scrolled, "claude")).toBe(false);
  });

  it("only trusts a spinner glyph that leads its row", () => {
    // Claude bullets thinking blocks with the same glyph the spinner uses.
    expect(detectWorkingOnScreen(["✻ Pondering the parser"], "claude")).toBe(true);
    expect(detectWorkingOnScreen(["Wrote ✻ to the file"], "claude")).toBe(false);
  });

  it("takes any braille frame as a spinner, but not blank braille", () => {
    // grok cycles frames well past the common ⠋ to ⠏ subset.
    for (const frame of ["⠁", "⠋", "⣿", "⡇"]) {
      expect(detectWorkingOnScreen([`${frame} Running: bash`], "grok")).toBe(true);
    }
    expect(detectWorkingOnScreen(["⠀ idle"], "grok")).toBe(false);
  });

  it("does not read a plain terminal's spinner as an agent working", () => {
    // npm and vite print braille spinners. Treating those as work flipped a
    // vanilla shell to running and fired a ghost "Ready for input" after it.
    expect(detectWorkingOnScreen(["⠋ installing 412 packages"], "terminal")).toBe(false);
    expect(detectWorkingOnScreen(["⠋ installing 412 packages"], null)).toBe(false);
    // An interrupt hint is unambiguous whoever printed it.
    expect(detectWorkingOnScreen(["ctrl+c to cancel"], "terminal")).toBe(true);
  });

  it("ignores rows with no letters at all", () => {
    expect(detectWorkingOnScreen(["────────────", "│      │"], "codex")).toBe(false);
  });

  it("survives an empty or all-blank screen", () => {
    expect(detectWorkingOnScreen([], "claude")).toBe(false);
    expect(detectWorkingOnScreen(["", "   ", ""], "claude")).toBe(false);
  });

  it("keeps a footer that trailing blank rows would have pushed out", () => {
    const padded = [...CLAUDE_WORKING, "", "", "", "", ""];
    expect(detectWorkingOnScreen(padded, "claude")).toBe(true);
  });

  it("holds the window at the documented size", () => {
    // Claude's spinner is the fifth row up from the bottom of its own layout,
    // so shrinking this stops detecting the agent it was measured on.
    expect(LIVE_ROW_COUNT).toBe(5);
    expect(CLAUDE_WORKING.length).toBe(LIVE_ROW_COUNT);
  });
});
