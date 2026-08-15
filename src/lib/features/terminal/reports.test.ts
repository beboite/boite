import { describe, expect, it } from "vitest";
import { isTerminalReport } from "./reports";

const ESC = "\u001b";
const CSI = `${ESC}[`;
const ST = `${ESC}\\`;
const BEL = "\u0007";

describe("what the terminal answers on its own", () => {
  /**
   * The one the sidebar's order tripped over. Every pane taking focus writes
   * a focus-in, every pane losing it writes a focus-out, and both used to
   * count as the user typing into that thread.
   */
  it("knows the focus reports", () => {
    expect(isTerminalReport(`${CSI}I`)).toBe(true);
    expect(isTerminalReport(`${CSI}O`)).toBe(true);
  });

  it("knows a mouse report in the encodings that reach onData", () => {
    expect(isTerminalReport(`${CSI}<0;12;24M`)).toBe(true);
    expect(isTerminalReport(`${CSI}<64;12;24m`)).toBe(true);
    expect(isTerminalReport(`${CSI}32;12;24M`)).toBe(true);
  });

  it("knows the answers to a query the agent made", () => {
    expect(isTerminalReport(`${CSI}?1;2c`)).toBe(true);
    expect(isTerminalReport(`${CSI}>0;276;0c`)).toBe(true);
    expect(isTerminalReport(`${CSI}12;40R`)).toBe(true);
    expect(isTerminalReport(`${CSI}?12;40;1R`)).toBe(true);
    expect(isTerminalReport(`${CSI}0n`)).toBe(true);
    expect(isTerminalReport(`${CSI}?2004;1$y`)).toBe(true);
    expect(isTerminalReport(`${ESC}]11;rgb:1e1e/1e1e/2e2e${BEL}`)).toBe(true);
    expect(isTerminalReport(`${ESC}P1+r544e=787465726d${ST}`)).toBe(true);
  });
});

describe("what the user typed", () => {
  it("leaves plain text alone", () => {
    expect(isTerminalReport("a")).toBe(false);
    expect(isTerminalReport("bonjour")).toBe(false);
    expect(isTerminalReport("\r")).toBe(false);
    expect(isTerminalReport("")).toBe(false);
  });

  /** Every one of these is a key, and every one of them starts with an ESC. */
  it("leaves the escape-prefixed keys alone", () => {
    for (const key of ["A", "B", "C", "D", "H", "F", "Z", "3~", "15~", "1;5A"]) {
      expect(isTerminalReport(`${CSI}${key}`)).toBe(false);
    }
    expect(isTerminalReport(ESC)).toBe(false);
    expect(isTerminalReport(`${ESC}a`)).toBe(false);
  });

  /**
   * A back-tab is `ESC [ Z`, but `ESC [ 2 I` is a parameterised horizontal tab
   * and not a focus report. Only the bare form is one.
   */
  it("leaves a parameterised final alone", () => {
    expect(isTerminalReport(`${CSI}2I`)).toBe(false);
    expect(isTerminalReport(`${CSI}3O`)).toBe(false);
  });

  /** Half of an answer is not an answer: an unterminated OSC is a paste. */
  it("leaves an unterminated OSC or DCS alone", () => {
    expect(isTerminalReport(`${ESC}]11;rgb:1e1e`)).toBe(false);
    expect(isTerminalReport(`${ESC}P1+r544e`)).toBe(false);
  });
});
