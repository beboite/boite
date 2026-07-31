import { describe, expect, it } from "vitest";
import { detectWorkingOnScreen, LIVE_ROW_COUNT } from "./working-detect";

// Claude's idle bottom, copied off a running one rather than imagined: the box,
// then whatever the user has hung under it. A warning banner, a statusline and
// the mode hint are three rows on their own, and they are what a fixed five-row
// window could not see past.
const CLAUDE_IDLE = [
  "──────────────────────────────────────────────────",
  "❯                                                 ",
  "──────────────────────────────────────────────────",
  "  ⚠ Transcript saving is off",
  "  [CAVEMAN:FULL]  [Fable 5 High]  41k/1M 4%  5h ██████ 66%",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

// Mid-turn: the spinner line and its token count ride above the same box, eight
// rows up from the bottom.
const CLAUDE_WORKING = [
  "✶ Burrowing… (1m 4s · ↓ 374 tokens)",
  "                                          41461 tokens",
  ...CLAUDE_IDLE,
];

describe("detectWorkingOnScreen", () => {
  it("reads claude's real layout as working and its absence as done", () => {
    // The regression: this exact screen read as finished while the agent was
    // visibly thinking, because the spinner sits further up than the window
    // reached once the user has a statusline.
    expect(CLAUDE_WORKING.length).toBeGreaterThan(5);
    expect(detectWorkingOnScreen(CLAUDE_WORKING, "claude")).toBe(true);
    expect(detectWorkingOnScreen(CLAUDE_IDLE, "claude")).toBe(false);
  });

  it("stops at the gap above the agent's chrome", () => {
    // The other half of the same fix. Reaching higher for the spinner means
    // reaching into the transcript, where a finished turn's own thinking block
    // leads its row with the glyph the spinner uses. The blank row every agent
    // leaves above its box is the boundary, and the walk ends there.
    const scrolled = [
      "● Bash(cargo test)",
      "✻ Thinking… (4s · esc to interrupt)",
      "● Done. 42 tests passed.",
      "",
      ...CLAUDE_IDLE,
    ];
    expect(detectWorkingOnScreen(scrolled, "claude")).toBe(false);
    // Same rows, no gap, and the transcript is part of what is being repainted.
    expect(detectWorkingOnScreen(scrolled.filter((r) => r !== ""), "claude")).toBe(true);
  });

  it("reads every frame claude cycles through, glyph or not", () => {
    // Sampled off a working agent ten times a second: one status line rotated
    // through all of these, an ASCII asterisk and a middle dot included. Any
    // hand-listed glyph set matches some and misses others, which showed up as
    // the dot flickering on and off twice a second on an agent plainly at work.
    for (const frame of ["✻", "✽", "✶", "✳", "✢", "∗", "∴", "*", "·"]) {
      expect(detectWorkingOnScreen([`${frame} Burrowing… (3s)`], "claude")).toBe(true);
    }
    // Which is why the glyph is not what is being read. The row is.
    expect(detectWorkingOnScreen(["Burrowing… (3s · ↓ 12 tokens)"], "claude")).toBe(true);
  });

  it("needs both halves of a live row, not either one", () => {
    // An elapsed count on its own is what a finished turn prints, and an ellipsis
    // on its own is any truncated line of output.
    expect(detectWorkingOnScreen(["✻ Pondering the parser… (3s)"], "claude")).toBe(true);
    expect(detectWorkingOnScreen(["  ⎿  Tip: use alt+v to paste images…"], "claude")).toBe(false);
    expect(detectWorkingOnScreen(["● Bash(sleep 45) took 3s"], "claude")).toBe(false);
  });

  it("does not take claude's finished-turn line for its spinner", () => {
    // Caught on a running agent, not in a fixture: claude leads the line it
    // prints when a turn ENDS with a glyph from the same set, and leaves it there
    // until the next one. The row is what tells them apart, so a bullet glyph
    // needs an ellipsis, an elapsed-time parenthetical or an interrupt hint on it
    // and the finished line has none of the three.
    expect(detectWorkingOnScreen(["✻ Crunched for 2s", ...CLAUDE_IDLE], "claude")).toBe(false);
    expect(detectWorkingOnScreen(["✻ Cogitated for 1m 4s", ...CLAUDE_IDLE], "claude")).toBe(false);
    // The live row of the very same session, one turn later.
    expect(
      detectWorkingOnScreen(
        ["✢ Symbioting… (2s · thinking with high effort)", ...CLAUDE_IDLE],
        "claude",
      ),
    ).toBe(true);
    // A braille frame needs no such proof: nothing leaves one on screen after a
    // turn, which is why grok's spinner alone is still enough.
    expect(detectWorkingOnScreen(["⠹ Running: bash"], "grok")).toBe(true);
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

  it("caps how far a screen with no gap left in it is read", () => {
    // Only reachable when nothing on the visible screen is blank, which is a
    // wall of output rather than an agent's chrome. The cap is what keeps that
    // case from being scanned whole.
    const wall = Array.from({ length: LIVE_ROW_COUNT + 4 }, (_, i) => `line ${i} of output`);
    expect(detectWorkingOnScreen(["✻ Burrowing… (3s)", ...wall], "claude")).toBe(false);
    // One row inside the cap, and the same spinner is read.
    const justInside = wall.slice(0, LIVE_ROW_COUNT - 1);
    expect(detectWorkingOnScreen(["✻ Burrowing… (3s)", ...justInside], "claude")).toBe(true);
  });
});
