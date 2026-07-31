import { describe, expect, it, vi } from "vitest";
import {
  createKeyboardController,
  isEditableTarget,
  matchesCombo,
  parseCombo,
} from "./controller";
import type { KeyScope, ShortcutBinding } from "./types";

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
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
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
    expect(
      matchesCombo(combo("mod+digit1"), key({ key: "1", ctrl: true }), false),
    ).toBe(true);
    expect(
      matchesCombo(combo("mod+digit1"), key({ key: "1", code: "Numpad1", ctrl: true }), false),
    ).toBe(true);
  });

  it("matches the split keys on both layouts and leaves Ctrl+backslash alone", () => {
    // E and O sit in the same place on QWERTY and AZERTY, so the character the
    // key produces identifies it on either.
    expect(
      matchesCombo(combo("mod+shift+e"), key({ key: "E", code: "KeyE", ctrl: true, shift: true }), false),
    ).toBe(true);
    expect(
      matchesCombo(combo("mod+shift+o"), key({ key: "O", code: "KeyO", ctrl: true, shift: true }), false),
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
      expect(matchesCombo(combo("mod+minus"), key({ key: k, ctrl: true }), false)).toBe(true);
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

describe("createKeyboardController", () => {
  function build(bindings: ShortcutBinding[], scope: KeyScope = "app") {
    return createKeyboardController({
      bindings,
      getScope: () => scope,
      isMac: () => false,
    });
  }

  it("runs the first matching binding and stops the event", () => {
    const first = vi.fn();
    const second = vi.fn();
    const c = build([
      { combo: "mod+t", scopes: ["*"], run: first },
      { combo: "mod+t", scopes: ["*"], run: second },
    ]);
    const e = key({ key: "t", ctrl: true });
    c.handleKeydown(e);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
  });

  it("falls through to the next binding when run() returns false", () => {
    // This is what lets "close the front-most thing" decline when there is
    // nothing to close, instead of swallowing the key.
    const declined = vi.fn(() => false);
    const taken = vi.fn();
    const c = build([
      { combo: "mod+w", scopes: ["*"], run: declined },
      { combo: "mod+w", scopes: ["*"], run: taken },
    ]);
    const e = key({ key: "w", ctrl: true });
    c.handleKeydown(e);
    expect(declined).toHaveBeenCalledOnce();
    expect(taken).toHaveBeenCalledOnce();
  });

  it("leaves the event untouched when nothing matches", () => {
    const c = build([{ combo: "mod+t", scopes: ["*"], run: vi.fn() }]);
    const e = key({ key: "q", ctrl: true });
    c.handleKeydown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("skips bindings that are out of scope", () => {
    const run = vi.fn();
    const c = build([{ combo: "escape", scopes: ["editor"], run }], "modal");
    c.handleKeydown(key({ key: "Escape" }));
    expect(run).not.toHaveBeenCalled();
  });

  it("a modal scope silences app bindings, so Escape closes one layer", () => {
    const closePanel = vi.fn();
    const c = build([{ combo: "escape", scopes: ["app"], run: closePanel }], "modal");
    c.handleKeydown(key({ key: "Escape" }));
    expect(closePanel).not.toHaveBeenCalled();
  });

  it("does not fire bare keys while a text field has focus", () => {
    const run = vi.fn();
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    const c = build([{ combo: "escape", scopes: ["*"], run }]);
    c.handleKeydown(key({ key: "Escape", target: input }));
    expect(run).not.toHaveBeenCalled();
  });

  it("still fires bare keys in a text field when the binding opts in", () => {
    const run = vi.fn();
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    const c = build([
      { combo: "escape", scopes: ["*"], allowInInput: true, run },
    ]);
    c.handleKeydown(key({ key: "Escape", target: input }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("still fires modifier combos inside a text field", () => {
    // The user cannot have meant to type Ctrl+W into the box.
    const run = vi.fn();
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    const c = build([{ combo: "mod+w", scopes: ["*"], run }]);
    c.handleKeydown(key({ key: "w", ctrl: true, target: input }));
    expect(run).toHaveBeenCalledOnce();
  });
});
