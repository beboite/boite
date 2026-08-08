import type { Thread } from "$lib/types";
import { settings } from "$lib/features/settings/store.svelte";
import { fastpick } from "./store.svelte";
import { parseCombo } from "./combo";
import { ACCENT_COLOR, modelAccent, type ModelAccent } from "./accent";

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

// Nothing is handed to the agent to make its own interface agree with the icon.
// Boite used to pass `/color <name>` as Claude Code's opening prompt, and the
// cost was a slash command running and an answer printed at the top of every
// launch, for a strip of colour the sidebar already showed. The tint above is
// the whole feature now, and unlike the prompt it is derived, so the setting
// reaches every existing thread rather than only the next one.
