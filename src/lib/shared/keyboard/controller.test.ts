import { describe, expect, it, vi } from "vitest";
import { parseCombo } from "./combo";
import { createKeyboardController } from "./controller";
import { compileWhen, type KeyContext } from "./when";
import type { CompiledRule, Keybinding, KeyCommandRun } from "./types";

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

function compile(bindings: Keybinding[], allowInInput: string[] = []): CompiledRule[] {
  return bindings.map((binding) => {
    const clause = compileWhen(binding.when);
    return {
      binding,
      combo: parseCombo(binding.key),
      test: clause.test,
      valid: clause.ok,
      allowInInput: allowInInput.includes(binding.command),
    };
  });
}

function build(
  bindings: Keybinding[],
  handlers: Record<string, KeyCommandRun>,
  ctx: KeyContext = {},
  allowInInput: string[] = [],
) {
  const rules = compile(bindings, allowInInput);
  return createKeyboardController({
    rules: () => rules,
    context: () => ctx,
    handlers: () => handlers,
    isMac: () => false,
  });
}

describe("createKeyboardController", () => {
  it("runs the LAST matching rule and stops the event", () => {
    // The inverse of what this dispatcher used to do, and the whole of what
    // makes a user override work: their rule is appended behind the default.
    const first = vi.fn();
    const second = vi.fn();
    const c = build(
      [
        { key: "mod+t", command: "a" },
        { key: "mod+t", command: "b" },
      ],
      { a: first, b: second },
    );
    const e = key({ key: "t", ctrl: true });
    c.handleKeydown(e);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
  });

  it("lets a later rule beat an earlier one on a different command", () => {
    const shipped = vi.fn();
    const mine = vi.fn();
    const c = build(
      [
        { key: "mod+t", command: "thread.new" },
        { key: "mod+t", command: "view.toggleSidebar" },
      ],
      { "thread.new": shipped, "view.toggleSidebar": mine },
    );
    c.handleKeydown(key({ key: "t", ctrl: true }));
    expect(mine).toHaveBeenCalledOnce();
    expect(shipped).not.toHaveBeenCalled();
  });

  it("falls back to the rule in front when run() returns false", () => {
    // This is what lets "close the front-most thing" decline when there is
    // nothing to close, instead of swallowing the key.
    const declined = vi.fn(() => false);
    const taken = vi.fn();
    const c = build(
      [
        { key: "mod+w", command: "a" },
        { key: "mod+w", command: "b" },
      ],
      { a: taken, b: declined },
    );
    const e = key({ key: "w", ctrl: true });
    c.handleKeydown(e);
    expect(declined).toHaveBeenCalledOnce();
    expect(taken).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves the event untouched when every matching rule declines", () => {
    const c = build([{ key: "mod+w", command: "a" }], { a: () => false });
    const e = key({ key: "w", ctrl: true });
    c.handleKeydown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves the event untouched when nothing matches", () => {
    const c = build([{ key: "mod+t", command: "a" }], { a: vi.fn() });
    const e = key({ key: "q", ctrl: true });
    c.handleKeydown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("skips a rule whose clause is false", () => {
    const run = vi.fn();
    const c = build([{ key: "escape", command: "a", when: "editorFocus" }], { a: run }, {
      editorFocus: false,
    });
    c.handleKeydown(key({ key: "Escape" }));
    expect(run).not.toHaveBeenCalled();
  });

  it("silences the rules behind an overlay, so Escape closes one layer", () => {
    const closePanel = vi.fn();
    const c = build([{ key: "escape", command: "a", when: "!overlayOpen" }], { a: closePanel }, {
      overlayOpen: true,
    });
    c.handleKeydown(key({ key: "Escape" }));
    expect(closePanel).not.toHaveBeenCalled();
  });

  it("skips a rule whose clause did not parse", () => {
    const run = vi.fn();
    const c = build([{ key: "mod+t", command: "a", when: "editorFocus &&" }], { a: run });
    c.handleKeydown(key({ key: "t", ctrl: true }));
    expect(run).not.toHaveBeenCalled();
  });

  it("skips a rule naming a command this build does not have", () => {
    // An older Boite reading a set a newer one wrote still has to boot.
    const fallback = vi.fn();
    const c = build(
      [
        { key: "mod+t", command: "known" },
        { key: "mod+t", command: "from.the.future" },
      ],
      { known: fallback },
    );
    c.handleKeydown(key({ key: "t", ctrl: true }));
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("does not fire bare keys while a text field has focus", () => {
    const run = vi.fn();
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    const c = build([{ key: "escape", command: "a" }], { a: run });
    c.handleKeydown(key({ key: "Escape", target: input }));
    expect(run).not.toHaveBeenCalled();
  });

  it("still fires bare keys in a text field when the command opts in", () => {
    const run = vi.fn();
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    const c = build([{ key: "escape", command: "a" }], { a: run }, {}, ["a"]);
    c.handleKeydown(key({ key: "Escape", target: input }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("still fires modifier combos inside a text field", () => {
    // The user cannot have meant to type Ctrl+W into the box.
    const run = vi.fn();
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    const c = build([{ key: "mod+w", command: "a" }], { a: run });
    c.handleKeydown(key({ key: "w", ctrl: true, target: input }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not read the context for a keystroke no combo claims", () => {
    // The clause context probes the DOM, and this runs on every key the
    // terminal is also about to receive.
    const context = vi.fn(() => ({}));
    const rules = compile([{ key: "mod+t", command: "a" }]);
    const c = createKeyboardController({
      rules: () => rules,
      context,
      handlers: () => ({ a: vi.fn() }),
      isMac: () => false,
    });
    c.handleKeydown(key({ key: "z" }));
    expect(context).not.toHaveBeenCalled();
    c.handleKeydown(key({ key: "t", ctrl: true }));
    expect(context).toHaveBeenCalledOnce();
  });
});
