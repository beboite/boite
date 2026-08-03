import { describe, expect, it } from "vitest";
import {
  applyCtrl,
  encodeBarKey,
  encodeChar,
  encodeText,
  isLineFeed,
  wheelLines,
  NO_MODIFIERS,
} from "./keys";

const armed = (ctrl: boolean, alt: boolean) => ({ ctrl, alt });

describe("control characters", () => {
  it("reaches the C0 block from both cases", () => {
    expect(applyCtrl("c")).toBe("\x03");
    expect(applyCtrl("C")).toBe("\x03");
    // `Ctrl+[` is Escape, which is the same byte the esc key sends.
    expect(applyCtrl("[")).toBe("\x1b");
    expect(applyCtrl("@")).toBe("\x00");
  });

  it("leaves alone what has no control form", () => {
    expect(applyCtrl("1")).toBe("1");
    expect(applyCtrl("é")).toBe("é");
  });

  it("prefixes alt with escape, after ctrl", () => {
    expect(encodeChar("c", armed(true, true))).toBe("\x1b\x03");
    expect(encodeChar("c", armed(false, true))).toBe("\x1bc");
  });
});

describe("the key bar", () => {
  it("arms a modifier without sending anything", () => {
    expect(encodeBarKey("ctrl", NO_MODIFIERS)).toEqual({
      send: null,
      modifiers: armed(true, false),
    });
    // And a second tap disarms it, which is what makes it sticky rather than
    // a key nobody can let go of.
    expect(encodeBarKey("ctrl", armed(true, false)).modifiers).toEqual(armed(false, false));
  });

  it("spends both modifiers on anything that sends", () => {
    const press = encodeBarKey("esc", armed(true, true));
    expect(press.send).toBe("\x1b");
    expect(press.modifiers).toEqual(NO_MODIFIERS);
  });

  /// The xterm encoding, which is the reason this is worth a test at all: a
  /// plain arrow is the short form and a modified one carries a bitmask.
  it("encodes an arrow the way a VT reads it", () => {
    expect(encodeBarKey("up", NO_MODIFIERS).send).toBe("\x1b[A");
    expect(encodeBarKey("up", armed(false, true)).send).toBe("\x1b[1;3A");
    expect(encodeBarKey("up", armed(true, false)).send).toBe("\x1b[1;5A");
    expect(encodeBarKey("left", armed(true, true)).send).toBe("\x1b[1;7D");
  });

  it("sends tab with alt as an escape prefix", () => {
    expect(encodeBarKey("tab", NO_MODIFIERS).send).toBe("\t");
    expect(encodeBarKey("tab", armed(false, true)).send).toBe("\x1b\t");
  });

  it("treats an unknown id as a literal character", () => {
    expect(encodeBarKey("/", NO_MODIFIERS).send).toBe("/");
    expect(encodeBarKey("c", armed(true, false)).send).toBe("\x03");
  });
});

describe("text from the soft keyboard", () => {
  it("applies the armed modifiers to one character", () => {
    expect(encodeText("c", armed(true, false))).toEqual({
      send: "\x03",
      modifiers: NO_MODIFIERS,
    });
  });

  /// A pasted line is not a keystroke. Applying Ctrl to its first letter is
  /// never what anybody meant, and the modifiers stay armed for the key that
  /// was actually going to use them.
  it("passes anything longer through untouched", () => {
    const mods = armed(true, false);
    expect(encodeText("hello", mods)).toEqual({ send: "hello", modifiers: mods });
  });

  it("sends nothing for nothing", () => {
    expect(encodeText("", NO_MODIFIERS).send).toBe(null);
  });
});

describe("wheel scrolling", () => {
  it("reads all three delta units", () => {
    expect(wheelLines(3, 1, 24)).toBe(3);
    expect(wheelLines(1, 2, 24)).toBe(12);
    expect(wheelLines(100, 0, 24)).toBe(5);
  });

  /// A trackpad fling arrives as one enormous delta, and scrolling a whole
  /// scrollback in a frame is a jump rather than a scroll.
  it("clamps a fling and keeps its direction", () => {
    expect(wheelLines(100000, 0, 24)).toBe(12);
    expect(wheelLines(-100000, 0, 24)).toBe(-12);
    // And never rounds a real movement down to nothing.
    expect(wheelLines(1, 0, 24)).toBe(1);
    expect(wheelLines(0, 0, 24)).toBe(0);
  });
});

describe("newline inside the prompt", () => {
  const key = (over: Partial<KeyboardEvent> = {}) =>
    ({ ctrlKey: false, shiftKey: false, altKey: false, key: "", ...over }) as KeyboardEvent;

  it("takes shift+enter when the setting or the agent asks for it", () => {
    const shiftEnter = key({ shiftKey: true });
    expect(isLineFeed(shiftEnter, "Enter", { codex: true, powershellNewline: false })).toBe(true);
    expect(isLineFeed(shiftEnter, "Enter", { codex: false, powershellNewline: true })).toBe(true);
    expect(isLineFeed(shiftEnter, "Enter", { codex: false, powershellNewline: false })).toBe(false);
  });

  /// Codex also takes the literal line feed, and `code` alone is not enough:
  /// a non-QWERTY layout does not have `KeyJ` under the user's finger.
  it("takes ctrl+j for codex whatever the layout calls it", () => {
    const opts = { codex: true, powershellNewline: false };
    expect(isLineFeed(key({ ctrlKey: true, key: "j" }), "KeyJ", opts)).toBe(true);
    expect(isLineFeed(key({ ctrlKey: true, key: "j" }), "KeyC", opts)).toBe(true);
    expect(isLineFeed(key({ ctrlKey: true, key: "" }), "KeyJ", opts)).toBe(true);
    // Not for anybody else, where Ctrl+J is the shell's own.
    expect(
      isLineFeed(key({ ctrlKey: true, key: "j" }), "KeyJ", {
        codex: false,
        powershellNewline: true,
      }),
    ).toBe(false);
  });

  it("leaves a plain enter alone", () => {
    const opts = { codex: true, powershellNewline: true };
    expect(isLineFeed(key(), "Enter", opts)).toBe(false);
    expect(isLineFeed(key({ shiftKey: true, ctrlKey: true }), "Enter", opts)).toBe(false);
  });
});
