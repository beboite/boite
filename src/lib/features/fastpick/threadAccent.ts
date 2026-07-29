import type { Thread } from "$lib/types";
import { settings } from "$lib/features/settings/store.svelte";
import { fastpick } from "./store.svelte";
import { parseCombo, type FastpickCombo } from "./combo";
import { ACCENT_COLOR, CLAUDE_BAR_COLOR, modelAccent, type ModelAccent } from "./accent";

/**
 * The colour a thread's agent icon is drawn in.
 *
 * Computed at render rather than stored on the row, which is what makes the setting a
 * setting: turning it off restores every existing thread instead of only the next one. It
 * also means a thread a process promoted through the OSC sequence is tinted exactly like
 * one launched from the menu, since both are read back from the command.
 *
 * A colour the user chose on the shortcut wins. They picked it, and a tint nobody asked
 * for has no business overruling that.
 */
export function threadIconColor(thread: Thread): string | null {
  if (thread.iconColor) return thread.iconColor;
  if (!settings.state.colorByModel) return null;
  const accent = threadAccent(thread);
  return accent ? ACCENT_COLOR[accent] : null;
}

/** What is answering this thread, or null when it is not a fastpick thread. */
export function threadAccent(thread: Thread): ModelAccent | null {
  const combo = parseCombo(thread.cmd, thread.args);
  if (!combo) return null;
  return modelAccent(combo, fastpick.providerById(combo.provider));
}

/**
 * What to hand the agent so its own interface agrees with the icon.
 *
 * Claude Code paints its prompt bar from `/color`, and a slash command given as the first
 * prompt is run locally rather than sent anywhere, so passing it costs nothing. fastpick
 * forwards everything after `--` to the agent it launches.
 *
 * Only Claude Code has this. The others get an empty list rather than an argument they
 * would have to reject.
 *
 * Decided once, at launch, unlike the icon tint: a process that is already running cannot
 * be repainted from outside, so turning the setting off reaches the next thread, not this
 * one.
 */
export function barColorArgs(combo: FastpickCombo, harnessKind: string): string[] {
  if (!settings.state.colorByModel || harnessKind !== "claude-code") return [];
  const accent = modelAccent(combo, fastpick.providerById(combo.provider));
  const color = CLAUDE_BAR_COLOR[accent];
  return color ? ["--", `/color ${color}`] : [];
}
