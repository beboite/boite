import { normalizeCombo } from "./combo";
import { DEFAULT_KEYBINDINGS } from "./defaults";
import type { Keybinding } from "./types";

/**
 * A stored set, read defensively. It arrives from a settings blob that a remote
 * boite may have written, so every field is checked and anything malformed is
 * dropped rather than allowed to become a rule.
 *
 * `null` means "no set stored", which is a different answer from "an empty set"
 * — the first seeds the defaults, the second is a user who unbound everything.
 */
export function sanitizeKeybindings(raw: unknown): Keybinding[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Keybinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rule = entry as Record<string, unknown>;
    if (typeof rule.key !== "string" || typeof rule.command !== "string") continue;
    if (!rule.key.trim() || !rule.command.trim()) continue;
    out.push({
      key: rule.key.trim(),
      command: rule.command.trim(),
      when: typeof rule.when === "string" && rule.when.trim() ? rule.when.trim() : undefined,
    });
  }
  return out;
}

/**
 * Lay the shipped defaults over the user's set without ever touching what is
 * already there.
 *
 * A default is added unless a user rule already claims its command or its key.
 * Claims are read off the incoming set only, never off the growing result, so
 * two defaults on one command (the palette has two) both survive a first run
 * while a build that adds a second key later leaves a user who rebound that
 * command alone.
 */
export function mergeDefaultKeybindings(
  user: Keybinding[] | null,
  defaults: Keybinding[] = DEFAULT_KEYBINDINGS,
): { bindings: Keybinding[]; changed: boolean } {
  if (!user) return { bindings: defaults.map((b) => ({ ...b })), changed: true };

  const claimedCommands = new Set(user.map((b) => b.command));
  const claimedKeys = new Set(user.map((b) => normalizeCombo(b.key)));

  const bindings = user.map((b) => ({ ...b }));
  let changed = false;
  for (const def of defaults) {
    if (claimedCommands.has(def.command)) continue;
    if (claimedKeys.has(normalizeCombo(def.key))) continue;
    bindings.push({ ...def });
    changed = true;
  }
  return { bindings, changed };
}

export function defaultsForCommand(
  command: string,
  defaults: Keybinding[] = DEFAULT_KEYBINDINGS,
): Keybinding[] {
  return defaults.filter((b) => b.command === command).map((b) => ({ ...b }));
}

/**
 * Put one command back the way it shipped: its rules are dropped and the
 * defaults for it are appended. A command the defaults never bound simply ends
 * up unbound, which is the honest reading of "reset".
 */
export function resetCommand(
  bindings: Keybinding[],
  command: string,
  defaults: Keybinding[] = DEFAULT_KEYBINDINGS,
): Keybinding[] {
  return [
    ...bindings.filter((b) => b.command !== command),
    ...defaultsForCommand(command, defaults),
  ];
}

/**
 * Bind a command to one key, replacing whatever it had.
 *
 * The rule goes on the end because the last match wins: a user rule on a key a
 * default also claims has to beat it, and position is the only thing that says
 * so.
 */
export function setCommandKey(
  bindings: Keybinding[],
  command: string,
  key: string,
  when?: string,
): Keybinding[] {
  const kept = bindings.filter((b) => b.command !== command);
  const previous = bindings.find((b) => b.command === command);
  return [...kept, { key, command, when: when ?? previous?.when }];
}
