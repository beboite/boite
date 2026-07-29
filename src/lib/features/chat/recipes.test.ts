import { describe, expect, it } from "vitest";
import { chatModeFor, recipeFor, stripAnsi } from "./recipes";

// Spelled out rather than pasted: a literal escape byte in a source file is
// invisible, and a test nobody can read is one nobody can trust.
const ESC = "\u001b";

describe("stripAnsi", () => {
  it("takes the escapes out and leaves the words", () => {
    const line = `${ESC}[32mhello${ESC}[0m ${ESC}]0;a title${ESC}\\world${ESC}[2K`;
    expect(stripAnsi(line)).toBe("hello world");
  });

  it("keeps newlines and tabs, which are the answer's shape", () => {
    expect(stripAnsi("one\n\ttwo\r\n")).toBe("one\n\ttwo\r\n");
  });
});

describe("recipes", () => {
  it("never leaves an agent unreachable", () => {
    // The point of the fallback: an agent with no recipe still has a mode.
    expect(chatModeFor("hermes")).toBe("pty");
    expect(chatModeFor("copilot")).toBe("pty");
    expect(chatModeFor(null)).toBe("pty");
  });

  it("reads antigravity's print mode rather than driving its TUI", () => {
    expect(chatModeFor("antigravity")).toBe("text");
    const agy = recipeFor("antigravity")!;
    expect(agy.args({ prompt: "hi", sessionId: null, newSessionId: null })).toEqual([
      "--print",
      "hi",
    ]);
  });

  it("names claude's first session and resumes it only after that", () => {
    const claude = recipeFor("claude")!;
    expect(claude.mintsSession).toBe(true);

    // Turn one creates the session. Asking to resume it here is the bug this
    // pins: claude refuses an id nothing has written to, so the turn is lost.
    const first = claude.args({ prompt: "hi", sessionId: null, newSessionId: "abc" });
    expect(first).toContain("--session-id");
    expect(first).not.toContain("--resume");
    expect(first[first.indexOf("--session-id") + 1]).toBe("abc");

    const later = claude.args({ prompt: "hi", sessionId: "abc", newSessionId: null });
    expect(later).toContain("--resume");
    expect(later).not.toContain("--session-id");
    expect(later[later.indexOf("--resume") + 1]).toBe("abc");

    // The prompt is last, so nothing can be read as a value for a flag.
    expect(later.at(-1)).toBe("hi");
  });

  it("reads claude's streamed text and its final result", () => {
    const claude = recipeFor("claude")!;
    expect(
      claude.read!({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }, { type: "thinking" }] },
      }),
    ).toEqual({ kind: "text", text: "hello" });
    expect(claude.read!({ type: "result", result: "hello", is_error: false })).toEqual({
      kind: "done",
      text: "hello",
    });
    // A failed turn keeps what the agent managed to say; the subtype is the
    // part that names the failure, and it must not overwrite the answer.
    expect(
      claude.read!({
        type: "result",
        subtype: "error_max_turns",
        result: "half an answer",
        is_error: true,
      }),
    ).toEqual({ kind: "error", message: "error_max_turns", text: "half an answer" });
    expect(claude.read!({ type: "system", subtype: "init" })).toBeNull();
  });

  it("takes codex's thread id from the line that opens the turn", () => {
    const codex = recipeFor("codex")!;
    expect(codex.mintsSession).toBe(false);
    expect(codex.read!({ type: "thread.started", thread_id: "t-1" })).toEqual({
      kind: "session",
      id: "t-1",
    });
    expect(
      codex.read!({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    ).toEqual({ kind: "text", text: "hi" });
    // A tool call is an item too, and it is not the answer.
    expect(
      codex.read!({ type: "item.completed", item: { type: "command_execution" } }),
    ).toBeNull();
    expect(codex.read!({ type: "turn.completed" })).toEqual({ kind: "done" });
  });

  it("resumes codex as a subcommand, before its flags", () => {
    const codex = recipeFor("codex")!;
    expect(
      codex.args({ prompt: "hi", sessionId: "t-1", newSessionId: null }).slice(0, 3),
    ).toEqual(["exec", "resume", "t-1"]);
    // It names its own thread, so nothing should ever hand it one.
    expect(codex.mintsSession).toBe(false);
    expect(codex.args({ prompt: "hi", sessionId: null, newSessionId: null })[1]).not.toBe(
      "resume",
    );
  });
});
