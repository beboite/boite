import { describe, expect, it } from "vitest";
import { InstallOutput, TerminalQueries, lastRewrite, stripEscapes } from "./install-output";

const ESC = "";
const BEL = "";

describe("stripEscapes", () => {
  it("drops the colour cargo prints on a tty", () => {
    expect(stripEscapes(`${ESC}[1m${ESC}[32m   Compiling${ESC}[0m fastpick v1.0.0`)).toBe(
      "   Compiling fastpick v1.0.0",
    );
  });

  it("drops the line erase a progress bar repaints with", () => {
    expect(stripEscapes(`${ESC}[2K${ESC}[0G  Building [==>   ] 3/40`)).toBe(
      "  Building [==>   ] 3/40",
    );
  });

  it("drops a terminated OSC and keeps what follows it", () => {
    expect(stripEscapes(`${ESC}]0;cargo${BEL}done`)).toBe("done");
    expect(stripEscapes(`${ESC}]0;cargo${ESC}\\done`)).toBe("done");
  });

  it("leaves ordinary text alone, brackets included", () => {
    const line = "error[E0432]: unresolved import `foo::bar`";
    expect(stripEscapes(line)).toBe(line);
  });
});

describe("TerminalQueries", () => {
  it("answers the cursor report ConPTY suspends the child on", () => {
    // The one that mattered: unanswered, `cargo install` sat at zero CPU
    // having printed nothing else.
    expect(new TerminalQueries().answer(`${ESC}[6n`)).toBe(`${ESC}[1;1R`);
  });

  it("answers a status request and both device attribute forms", () => {
    const q = new TerminalQueries();
    expect(q.answer(`${ESC}[5n`)).toBe(`${ESC}[0n`);
    expect(q.answer(`${ESC}[c`)).toBe(`${ESC}[?1;2c`);
    expect(q.answer(`${ESC}[0c`)).toBe(`${ESC}[?1;2c`);
    expect(q.answer(`${ESC}[>c`)).toBe(`${ESC}[>0;0;0c`);
    expect(q.answer(`${ESC}[>0c`)).toBe(`${ESC}[>0;0;0c`);
  });

  it("answers a query split across two chunks", () => {
    const q = new TerminalQueries();
    expect(q.answer(`${ESC}[`)).toBe("");
    expect(q.answer("6n")).toBe(`${ESC}[1;1R`);
  });

  it("answers each query once and no more", () => {
    const q = new TerminalQueries();
    expect(q.answer(`${ESC}[6n`)).toBe(`${ESC}[1;1R`);
    expect(q.answer("   Compiling serde v1.0.0\n")).toBe("");
    expect(q.answer("")).toBe("");
  });

  it("answers every query in one chunk", () => {
    expect(new TerminalQueries().answer(`${ESC}[6n${ESC}[5n`)).toBe(`${ESC}[1;1R${ESC}[0n`);
  });

  it("says nothing about ordinary output, colour included", () => {
    const q = new TerminalQueries();
    expect(q.answer(`${ESC}[32m   Compiling${ESC}[0m fastpick v1.0.0\n`)).toBe("");
    expect(q.answer("error[E0432]: unresolved import\n")).toBe("");
  });

  it("forgets a half-seen query when told to", () => {
    const q = new TerminalQueries();
    q.answer(`${ESC}[`);
    q.clear();
    expect(q.answer("6n")).toBe("");
  });
});

describe("lastRewrite", () => {
  it("keeps only what the cursor painted last", () => {
    expect(lastRewrite("  Building 1/40\r  Building 7/40\r  Building 9/40")).toBe(
      "  Building 9/40",
    );
  });

  it("is the identity on a line nothing rewrote", () => {
    expect(lastRewrite("   Compiling serde v1.0.0")).toBe("   Compiling serde v1.0.0");
  });
});

describe("InstallOutput", () => {
  it("only publishes a line once its newline has arrived", () => {
    const out = new InstallOutput();
    out.push("   Compiling ser");
    expect(out.snapshot()).toEqual(["   Compiling ser"]);
    out.push("de v1.0.0\n");
    expect(out.snapshot()).toEqual(["   Compiling serde v1.0.0"]);
  });

  it("reassembles an escape-laden build across arbitrary chunks", () => {
    const out = new InstallOutput();
    out.push(`${ESC}[32m   Compiling${ESC}[0m serde v1.0.0\n`);
    out.push(`${ESC}[2K  Building 1/40\r${ESC}[2K  Building 40/40\n`);
    out.push(`${ESC}[32m    Finished${ESC}[0m release [optimized]\n`);
    expect(out.snapshot()).toEqual([
      "   Compiling serde v1.0.0",
      "  Building 40/40",
      "    Finished release [optimized]",
    ]);
  });

  it("keeps the tail once the limit is passed", () => {
    const out = new InstallOutput(3);
    for (let i = 0; i < 10; i++) out.push(`line ${i}\n`);
    expect(out.snapshot()).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("commits the last line of a process that died without a newline", () => {
    const out = new InstallOutput();
    out.push("error: could not compile `fastpick`");
    out.end();
    expect(out.snapshot()).toEqual(["error: could not compile `fastpick`"]);
    // `end` is not a second line: the pending text moved, it was not copied.
    out.end();
    expect(out.snapshot()).toEqual(["error: could not compile `fastpick`"]);
  });

  it("forgets everything a reset asked it to forget", () => {
    const out = new InstallOutput();
    out.push("stale\n");
    out.clear();
    expect(out.snapshot()).toEqual([]);
    expect(out.text()).toBe("");
  });
});
