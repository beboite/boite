import type { KeyScope, ParsedCombo, ShortcutBinding } from "./types";

/**
 * One capture-phase window listener arbitrates every global shortcut.
 *
 * The alternative — a handler per feature — is what produces the classic
 * double-fire bugs: Escape closing a dialog *and* the panel behind it, two
 * components both claiming Ctrl+W. Here the first binding whose scope and
 * combo match wins, and the event stops there. Capture phase means this runs
 * before any component-level `svelte:window` handler, so it can decide.
 */

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  return {
    key,
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

// Duck-typed rather than `instanceof HTMLElement`: an element that came from
// another realm (an iframe, a webview) fails that check even though it is very
// much a text field, and this way the dispatcher stays testable without a DOM.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Layout-independent aliases. `digit1` matches the physical key so a French
// AZERTY (where 1 is Shift+&) still jumps to thread 1, and `plus`/`minus`
// accept both the main row and the numpad.
function matchesKey(combo: string, event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  const code = event.code;

  if (combo.startsWith("digit")) {
    const digit = combo.slice(5);
    return code === `Digit${digit}` || code === `Numpad${digit}` || key === digit;
  }
  if (combo === "plus") {
    return key === "+" || key === "=" || code === "Equal" || code === "NumpadAdd";
  }
  if (combo === "minus") {
    return key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract";
  }
  // The physical key, like `digit`: Shift+\ produces "|" rather than "\", so
  // matching on event.key would give the plain and the shifted binding two
  // different names for one key. AZERTY reaches it through AltGr, where the
  // code is still Backslash.
  if (combo === "backslash") {
    return code === "Backslash" || key === "\\" || key === "|";
  }
  return key === combo;
}

export function matchesCombo(
  parsed: ParsedCombo,
  event: KeyboardEvent,
  isMac: boolean,
): boolean {
  const modDown = isMac ? event.metaKey : event.ctrlKey;
  // A stray modifier disqualifies the match. Without this, Ctrl+K on macOS
  // (a readline "kill line" the shell needs) would open the palette, and
  // Ctrl+Shift+T would also fire the plain Ctrl+T binding.
  const strayMod = isMac ? event.ctrlKey : event.metaKey;
  if (parsed.mod !== modDown) return false;
  if (strayMod) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  return matchesKey(parsed.key, event);
}

export interface KeyboardControllerOptions {
  bindings: ShortcutBinding[];
  getScope: () => KeyScope;
  isMac: () => boolean;
}

export function createKeyboardController(opts: KeyboardControllerOptions) {
  // Parsed once at construction, not per keystroke.
  const parsed = opts.bindings.map((binding) => ({
    binding,
    combo: parseCombo(binding.combo),
  }));

  function handleKeydown(event: KeyboardEvent) {
    const scope = opts.getScope();
    const isMac = opts.isMac();
    const editable = isEditableTarget(event.target);

    for (const { binding, combo } of parsed) {
      if (!binding.scopes.includes("*") && !binding.scopes.includes(scope)) {
        continue;
      }
      // Modifier combos are safe inside inputs; bare keys are not.
      const bare = !combo.mod && !combo.alt;
      if (editable && bare && !binding.allowInInput) continue;
      if (!matchesCombo(combo, event, isMac)) continue;

      if (binding.run(event) === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  function attach(): () => void {
    window.addEventListener("keydown", handleKeydown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeydown, { capture: true });
  }

  return { attach, handleKeydown };
}
