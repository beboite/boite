import { describe, expect, it } from "vitest";
import { detectWaitingOnScreen } from "./waiting-detect";

// Claude's permission dialog, box and all. Kept boxed on purpose: the borders are
// what stops a question mark from being the last character on its row, which is
// the detail a naive `endsWith("?")` gets wrong on every one of these CLIs.
const CLAUDE_PERMISSION = [
  "╭──────────────────────────────────────────────────╮",
  "│ Bash command                                     │",
  "│   npm test                                       │",
  "│                                                  │",
  "│ Do you want to proceed?                          │",
  "│ ❯ 1. Yes                                         │",
  "│   2. Yes, and don't ask again this session       │",
  "│   3. No, and tell Claude what to do differently  │",
  "╰──────────────────────────────────────────────────╯",
];

// The same agent with nothing pending: an input box, a warning banner pinned for
// the session and a statusline. Two of those rows carry a `❯` and a `⚠`.
const CLAUDE_IDLE = [
  "──────────────────────────────────────────────────",
  "❯                                                 ",
  "──────────────────────────────────────────────────",
  "  ⚠ Transcript saving is off",
  "  [Fable 5 High]  41k/1M 4%",
];

const CLAUDE_WORKING = ["✶ Burrowing… (1m 4s · ↓ 374 tokens)", ...CLAUDE_IDLE];

describe("detectWaitingOnScreen", () => {
  it("reads a boxed permission dialog and hands back what it asked", () => {
    expect(detectWaitingOnScreen(CLAUDE_PERMISSION, "claude")).toBe("Do you want to proceed?");
  });

  it("says nothing about an idle or a working screen", () => {
    // The expensive mistake: a thread called `waiting` is held out of auto-sleep
    // for the life of the window and raises a notification for nothing. An input
    // prompt and a pinned warning must never be enough.
    expect(detectWaitingOnScreen(CLAUDE_IDLE, "claude")).toBeNull();
    expect(detectWaitingOnScreen(CLAUDE_WORKING, "claude")).toBeNull();
  });

  it("wants the answers too, not just a question mark", () => {
    // A question in the transcript is not a dialog. Without the selector drawn
    // against its options, an agent that merely asked something in prose would
    // read as blocked until its next repaint.
    const asked = ["● Should I also update the changelog?", ""];
    expect(detectWaitingOnScreen(asked, "claude")).toBeNull();
  });

  it("reads codex's ruled dialog, which has no question mark of its own", () => {
    const codex = [
      "▌ Allow Codex to run `rm -rf build`",
      "▌",
      "▌ 1. Yes, run it",
      "▌ 2. No, and tell Codex what to do",
    ];
    expect(detectWaitingOnScreen(codex, "codex")).toBe("Allow Codex to run `rm -rf build`");
  });

  it("takes a y/n footer on its own", () => {
    // No menu, one keypress, and nothing prints it except a program that has
    // stopped for an answer.
    expect(detectWaitingOnScreen(["Overwrite the existing branch? [y/N]"], "opencode")).toBe(
      "Overwrite the existing branch? [y/N]",
    );
  });

  it("reads hermes's ⚠ as the approval marker it documents, and nobody else's", () => {
    const hermes = ["⚠ waiting for approval: write src/main.rs"];
    expect(detectWaitingOnScreen(hermes, "hermes")).toBe(
      "⚠ waiting for approval: write src/main.rs",
    );
    // Claude keeps a ⚠ banner pinned under its box all session long.
    expect(detectWaitingOnScreen(hermes, "claude")).toBeNull();
  });

  it("stays out of plain terminals", () => {
    // git, npm and apt ask this all day, and a shell thread has no turn for the
    // question to belong to.
    const shell = ["Remove untracked files? [y/n]"];
    expect(detectWaitingOnScreen(shell, "terminal")).toBeNull();
    expect(detectWaitingOnScreen(shell, null)).toBeNull();
  });

  it("stops at the gap, like the working detector", () => {
    // A dialog that was answered scrolls into the transcript, with the agent's
    // own chrome repainted below it. The blank row between the two is what keeps
    // an answered question from reading as a live one.
    const answered = [...CLAUDE_PERMISSION, "", ...CLAUDE_IDLE];
    expect(detectWaitingOnScreen(answered, "claude")).toBeNull();
  });
});
