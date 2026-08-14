import type { ParsedCombo } from "./types";

/**
 * The combo vocabulary: parsing it, matching an event against it, reading one
 * back off a keypress, and spelling it for a human.
 *
 * Kept apart from the dispatcher because three unrelated callers need it — the
 * dispatcher, the settings editor that records a new combo, and the palette
 * that prints one — and only the first of those wants a listener.
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

/**
 * One spelling per combo, so `Shift+Mod+T` and `mod+shift+t` are one key when
 * the merge asks whether a user rule already claims it.
 */
export function normalizeCombo(combo: string): string {
  const parsed = parseCombo(combo);
  const parts: string[] = [];
  if (parsed.mod) parts.push("mod");
  if (parsed.alt) parts.push("alt");
  if (parsed.shift) parts.push("shift");
  parts.push(parsed.key);
  return parts.join("+");
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
//
// There is no alias for the backslash, and there cannot be a working one: on
// fr-AZERTY that character is AltGr+8, so the event arrives as `code: "Digit8"`
// with `altKey` set, which `matchesCombo` refuses on the alt modifier alone.
// `code: "Backslash"` on that layout is the `*`/`µ` key, an entirely different
// character.
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

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os", "altgraph"]);

/**
 * The combo a keypress spells, for the settings editor's record button.
 *
 * It writes the aliases rather than the character, which is the whole reason
 * recording exists instead of a text field: a user on AZERTY pressing Ctrl+1
 * sends `&`, and a rule holding `&` fires on nothing.
 *
 * `null` for a bare modifier — holding Ctrl is not a combo yet.
 */
export function comboFromEvent(event: KeyboardEvent, isMac: boolean): string | null {
  const raw = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(raw)) return null;

  const digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
  let key: string;
  if (digit) {
    key = `digit${digit}`;
  } else if (raw === "+" || raw === "=" || event.code === "NumpadAdd") {
    key = "plus";
  } else if (raw === "-" || raw === "_" || event.code === "NumpadSubtract") {
    key = "minus";
  } else {
    key = raw;
  }

  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

function keyLabel(key: string): string {
  if (key.startsWith("digit")) return key.slice(5);
  if (key === "plus") return "+";
  if (key === "minus") return "-";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * The chord spelled the way the platform spells it. A mac user reading "Ctrl+T"
 * is being told about a chord that does nothing there.
 */
export function formatCombo(combo: string, isMac: boolean): string {
  const parts = combo.split("+");
  const label = keyLabel(parts.pop() ?? "");
  if (isMac) {
    let out = "";
    if (parts.includes("alt")) out += "⌥";
    if (parts.includes("shift")) out += "⇧";
    if (parts.includes("mod")) out += "⌘";
    return out + label;
  }
  const chunks: string[] = [];
  if (parts.includes("mod")) chunks.push("Ctrl");
  if (parts.includes("shift")) chunks.push("Shift");
  if (parts.includes("alt")) chunks.push("Alt");
  chunks.push(label);
  return chunks.join("+");
}
