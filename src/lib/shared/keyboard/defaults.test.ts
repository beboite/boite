import { describe, expect, it } from "vitest";
import { KEY_COMMAND_BY_ID } from "./commands";
import { parseCombo } from "./combo";
import { createKeyboardController } from "./controller";
import { DEFAULT_KEYBINDINGS } from "./defaults";
import { compileWhen, type KeyContext } from "./when";
import type { CompiledRule } from "./types";

/**
 * The shipped table against the scope ladder it replaced. Every case here is a
 * sentence the old `scopes` array made, so a clause drifting is a failure
 * rather than a silent change of which layer owns a key.
 */

const RULES: CompiledRule[] = DEFAULT_KEYBINDINGS.map((binding) => {
  const clause = compileWhen(binding.when);
  return {
    binding,
    combo: parseCombo(binding.key),
    test: clause.test,
    valid: clause.ok,
    allowInInput: KEY_COMMAND_BY_ID[binding.command]?.allowInInput === true,
  };
});

type Layer = "terminal" | "settings" | "editor" | "project" | "palette" | "modal";

function context(layer: Layer): KeyContext {
  const paletteOpen = layer === "palette";
  const modalOpen = layer === "modal";
  return {
    paletteOpen,
    modalOpen,
    overlayOpen: paletteOpen || modalOpen,
    // An overlay sits over whatever view was showing; the terminal is the one
    // it sits over here, which is the case that must still stay silent.
    terminalFocus: layer === "terminal" || paletteOpen || modalOpen,
    settingsOpen: layer === "settings",
    editorFocus: layer === "editor",
    projectFocus: layer === "project",
    inputFocus: false,
    hasThread: true,
  };
}

interface Press {
  key: string;
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function fire(layer: Layer, press: Press): string | null {
  let fired: string | null = null;
  const handlers = Object.fromEntries(
    Object.keys(KEY_COMMAND_BY_ID).map((id) => [
      id,
      () => {
        fired = id;
      },
    ]),
  );
  const controller = createKeyboardController({
    rules: () => RULES,
    context: () => context(layer),
    handlers: () => handlers,
    isMac: () => false,
  });
  controller.handleKeydown({
    key: press.key,
    code: press.code ?? "",
    ctrlKey: press.ctrl ?? false,
    metaKey: false,
    shiftKey: press.shift ?? false,
    altKey: press.alt ?? false,
    target: null,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent);
  return fired;
}

describe("the shipped table reproduces the scope ladder", () => {
  it("runs the everywhere keys on every view", () => {
    for (const layer of ["terminal", "settings", "editor", "project"] as const) {
      expect(fire(layer, { key: "t", ctrl: true })).toBe("thread.new");
      expect(fire(layer, { key: "1", code: "Digit1", ctrl: true })).toBe("thread.jump1");
      expect(fire(layer, { key: "w", ctrl: true })).toBe("view.closeFrontMost");
    }
  });

  it("silences them under a modal, so Escape closes one layer", () => {
    expect(fire("modal", { key: "t", ctrl: true })).toBeNull();
    expect(fire("modal", { key: "w", ctrl: true })).toBeNull();
    expect(fire("modal", { key: "Escape" })).toBeNull();
  });

  it("lets the palette keep the keys that close it, and nothing else", () => {
    expect(fire("palette", { key: "k", ctrl: true })).toBe("palette.toggle");
    expect(fire("palette", { key: "P", code: "KeyP", ctrl: true, shift: true })).toBe(
      "palette.toggle",
    );
    expect(fire("palette", { key: "t", ctrl: true })).toBeNull();
    expect(fire("modal", { key: "k", ctrl: true })).toBeNull();
  });

  it("leaves Escape to whatever is running in the terminal", () => {
    expect(fire("terminal", { key: "Escape" })).toBeNull();
    for (const layer of ["settings", "editor", "project"] as const) {
      expect(fire(layer, { key: "Escape" })).toBe("view.backToTerminal");
    }
  });

  it("keeps splitting and pane cycling on the terminal alone", () => {
    expect(fire("terminal", { key: "E", code: "KeyE", ctrl: true, shift: true })).toBe(
      "pane.splitRight",
    );
    expect(fire("settings", { key: "E", code: "KeyE", ctrl: true, shift: true })).toBeNull();
    expect(fire("terminal", { key: "ArrowRight", ctrl: true, alt: true })).toBe("pane.next");
    expect(fire("terminal", { key: "ArrowUp", ctrl: true, alt: true })).toBe("pane.previous");
    expect(fire("editor", { key: "ArrowRight", ctrl: true, alt: true })).toBeNull();
  });

  it("does not let Ctrl+Shift+T fall through to Ctrl+T", () => {
    expect(fire("terminal", { key: "T", code: "KeyT", ctrl: true, shift: true })).toBe(
      "thread.restoreClosed",
    );
  });
});
