import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  formatCombo,
  isEditableTarget,
  matchesCombo,
  normalizeCombo,
  parseCombo,
} from "./combo";

interface FakeKeyInit {
  key?: string;
  code?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  target?: unknown;
}

function key(init: FakeKeyInit): KeyboardEvent {
  return {
    key: init.key ?? "",
    code: init.code ?? "",
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
    target: init.target ?? null,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;
}

describe("parseCombo", () => {
  it("splits modifiers from the key", () => {
    expect(parseCombo("mod+shift+t")).toEqual({
      key: "t",
      mod: true,
      shift: true,
      alt: false,
    });
  });

  it("handles a bare key", () => {
    expect(parseCombo("escape")).toEqual({
      key: "escape",
      mod: false,
      shift: false,
      alt: false,
    });
  });
});

describe("normalizeCombo", () => {
  it("gives one spelling to every ordering and casing", () => {
    expect(normalizeCombo("Shift+Mod+T")).toBe("mod+shift+t");
    expect(normalizeCombo("mod+shift+t")).toBe("mod+shift+t");
    expect(normalizeCombo("alt+mod+arrowleft")).toBe("mod+alt+arrowleft");
    expect(normalizeCombo("escape")).toBe("escape");
  });
});

describe("matchesCombo", () => {
  const combo = (s: string) => parseCombo(s);

  it("maps mod to Ctrl off macOS and Cmd on it", () => {
    expect(matchesCombo(combo("mod+k"), key({ key: "k", ctrl: true }), false)).toBe(true);
    expect(matchesCombo(combo("mod+k"), key({ key: "k", meta: true }), true)).toBe(true);
  });

  it("refuses Ctrl+K on macOS so the shell keeps readline kill-line", () => {
    expect(matchesCombo(combo("mod+k"), key({ key: "k", ctrl: true }), true)).toBe(false);
  });

  it("refuses a stray opposite modifier", () => {
    // Cmd+Ctrl+K is not the palette shortcut on either platform.
    expect(
      matchesCombo(combo("mod+k"), key({ key: "k", ctrl: true, meta: true }), false),
    ).toBe(false);
  });

  it("does not let a shifted combo fire its unshifted binding", () => {
    // Regression: Ctrl+Shift+T used to also trigger the plain Ctrl+T handler,
    // opening a new terminal on top of the restored one.
    expect(
      matchesCombo(combo("mod+t"), key({ key: "T", ctrl: true, shift: true }), false),
    ).toBe(false);
    expect(
      matchesCombo(combo("mod+shift+t"), key({ key: "T", ctrl: true, shift: true }), false),
    ).toBe(true);
  });

  it("is case-insensitive on the key", () => {
    expect(matchesCombo(combo("mod+b"), key({ key: "B", ctrl: true }), false)).toBe(true);
  });

  it("matches digits by physical key so shifted layouts still work", () => {
    // On AZERTY the digit row needs Shift, so e.key is "&" and only the code
    // identifies the key.
    expect(
      matchesCombo(combo("mod+digit1"), key({ key: "&", code: "Digit1", ctrl: true }), false),
    ).toBe(true);
    expect(matchesCombo(combo("mod+digit1"), key({ key: "1", ctrl: true }), false)).toBe(
      true,
    );
    expect(
      matchesCombo(combo("mod+digit1"), key({ key: "1", code: "Numpad1", ctrl: true }), false),
    ).toBe(true);
  });

  it("matches the split keys on both layouts and leaves Ctrl+backslash alone", () => {
    // E and O sit in the same place on QWERTY and AZERTY, so the character the
    // key produces identifies it on either.
    expect(
      matchesCombo(
        combo("mod+shift+e"),
        key({ key: "E", code: "KeyE", ctrl: true, shift: true }),
        false,
      ),
    ).toBe(true);
    expect(
      matchesCombo(
        combo("mod+shift+o"),
        key({ key: "O", code: "KeyO", ctrl: true, shift: true }),
        false,
      ),
    ).toBe(true);
    // Ctrl+\ is SIGQUIT and belongs to whatever is running in the terminal.
    // Nothing may claim it, and there is no alias that could: on fr-AZERTY the
    // backslash is AltGr+8, which arrives as Digit8 with altKey set.
    for (const e of [
      key({ key: "\\", code: "Backslash", ctrl: true }),
      key({ key: "\\", code: "Digit8", ctrl: true, alt: true }),
    ]) {
      expect(matchesCombo(combo("mod+shift+e"), e, false)).toBe(false);
      expect(matchesCombo(combo("mod+shift+o"), e, false)).toBe(false);
    }
  });

  it("accepts both spellings of zoom in and out", () => {
    for (const k of ["+", "="]) {
      expect(matchesCombo(combo("mod+plus"), key({ key: k, ctrl: true }), false)).toBe(true);
    }
    for (const k of ["-", "_"]) {
      expect(matchesCombo(combo("mod+minus"), key({ key: k, ctrl: true }), false)).toBe(
        true,
      );
    }
    expect(
      matchesCombo(combo("mod+plus"), key({ key: "a", code: "NumpadAdd", ctrl: true }), false),
    ).toBe(true);
  });

  it("requires the alt modifier when the combo declares it", () => {
    expect(
      matchesCombo(combo("mod+alt+arrowleft"), key({ key: "ArrowLeft", ctrl: true }), false),
    ).toBe(false);
    expect(
      matchesCombo(
        combo("mod+alt+arrowleft"),
        key({ key: "ArrowLeft", ctrl: true, alt: true }),
        false,
      ),
    ).toBe(true);
  });
});

describe("comboFromEvent", () => {
  it("writes the combo a rule can be stored as", () => {
    expect(comboFromEvent(key({ key: "T", code: "KeyT", ctrl: true, shift: true }), false)).toBe(
      "mod+shift+t",
    );
    expect(comboFromEvent(key({ key: "Escape", code: "Escape" }), false)).toBe("escape");
    expect(
      comboFromEvent(key({ key: "ArrowLeft", code: "ArrowLeft", ctrl: true, alt: true }), false),
    ).toBe("mod+alt+arrowleft");
  });

  it("writes the digit alias rather than the character the layout produced", () => {
    // The whole reason recording exists instead of a text field: on AZERTY
    // Ctrl+1 sends "&", and a rule holding "&" fires on nothing.
    expect(
      comboFromEvent(key({ key: "&", code: "Digit1", ctrl: true, shift: true }), false),
    ).toBe("mod+shift+digit1");
    expect(comboFromEvent(key({ key: "3", code: "Numpad3", ctrl: true }), false)).toBe(
      "mod+digit3",
    );
  });

  it("writes the plus and minus aliases", () => {
    expect(comboFromEvent(key({ key: "=", code: "Equal", ctrl: true }), false)).toBe(
      "mod+plus",
    );
    expect(comboFromEvent(key({ key: "-", code: "Minus", ctrl: true }), false)).toBe(
      "mod+minus",
    );
  });

  it("reads Cmd as mod on macOS and Ctrl as nothing", () => {
    expect(comboFromEvent(key({ key: "k", code: "KeyK", meta: true }), true)).toBe("mod+k");
    expect(comboFromEvent(key({ key: "k", code: "KeyK", ctrl: true }), true)).toBe("k");
  });

  it("refuses a bare modifier, which is not a combo yet", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta"]) {
      expect(comboFromEvent(key({ key: k, ctrl: true }), false)).toBeNull();
    }
  });

  it("round-trips through the matcher", () => {
    const e = key({ key: "&", code: "Digit1", ctrl: true, shift: true });
    const combo = comboFromEvent(e, false);
    expect(combo).not.toBeNull();
    expect(matchesCombo(parseCombo(combo as string), e, false)).toBe(true);
  });
});

describe("formatCombo", () => {
  it("spells a chord the way the platform spells it", () => {
    expect(formatCombo("mod+shift+t", false)).toBe("Ctrl+Shift+T");
    expect(formatCombo("mod+shift+t", true)).toBe("⇧⌘T");
    expect(formatCombo("escape", false)).toBe("escape");
  });

  it("prints the aliases as the key they stand for", () => {
    expect(formatCombo("mod+digit1", false)).toBe("Ctrl+1");
    expect(formatCombo("mod+plus", false)).toBe("Ctrl++");
    expect(formatCombo("mod+minus", false)).toBe("Ctrl+-");
  });
});

describe("isEditableTarget", () => {
  it("is false for a plain element and true for form fields", () => {
    // Plain objects on purpose: isEditableTarget duck-types, so these are
    // exactly what a cross-realm element looks like to it.
    const el = (tag: string, editable = false) =>
      ({ tagName: tag, isContentEditable: editable }) as unknown as EventTarget;
    expect(isEditableTarget(el("DIV"))).toBe(false);
    expect(isEditableTarget(el("INPUT"))).toBe(true);
    expect(isEditableTarget(el("TEXTAREA"))).toBe(true);
    expect(isEditableTarget(el("SELECT"))).toBe(true);
    expect(isEditableTarget(el("DIV", true))).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});
