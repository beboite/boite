import type { MessageKey } from "$lib/i18n/index.svelte";

/**
 * Every setting, and which page it is on.
 *
 * Seven pages and twenty-odd controls, and the only way to find one was to
 * remember which page it was on. "Where do I turn off the confirmation before
 * a thread closes" is a question the rail answers with seven guesses.
 *
 * The index is the dictionary. Each entry carries the same `MessageKey` its
 * control is labelled with rather than a copy of the words, so the search is
 * whatever language the app is in and cannot go stale against a reworded label.
 * `catalogue.test.ts` fails when an entry names a key no page anchors, which is
 * the only way this can rot: a control that moves page, or one added with no
 * entry, is invisible to search and nothing else notices.
 */

export type SettingsTabId =
  | "general"
  | "terminal"
  | "appearance"
  | "fastpick"
  | "logs"
  | "experiments"
  | "about";

export interface SettingEntry {
  tab: SettingsTabId;
  /** The control's own label key, which is also its anchor. */
  key: MessageKey;
  /** The sentence under it, searched too: it holds the words nobody guesses. */
  descKey?: MessageKey;
}

export const SETTINGS_CATALOGUE: SettingEntry[] = [
  { tab: "general", key: "general.pushTitle", descKey: "general.pushDesc" },
  { tab: "general", key: "shortcuts.title", descKey: "shortcuts.description" },

  { tab: "terminal", key: "terminalTab.defaultShell", descKey: "terminalTab.defaultShellDesc" },
  { tab: "terminal", key: "terminalTab.windowsTweaks" },
  { tab: "terminal", key: "terminalTab.psNewline", descKey: "terminalTab.psNewlineDesc" },
  { tab: "terminal", key: "terminalTab.psNoProfile", descKey: "terminalTab.psNoProfileDesc" },
  { tab: "terminal", key: "terminalTab.threadClose" },
  { tab: "terminal", key: "terminalTab.confirmClose", descKey: "terminalTab.confirmCloseDesc" },
  { tab: "terminal", key: "terminalTab.gitAutoFetch" },
  { tab: "terminal", key: "terminalTab.autoFetch", descKey: "terminalTab.autoFetchDesc" },
  { tab: "terminal", key: "terminalTab.agentLaunch" },
  { tab: "terminal", key: "terminalTab.threadWorktrees", descKey: "terminalTab.threadWorktreesDesc" },
  { tab: "terminal", key: "terminalTab.agentTodoAccess", descKey: "terminalTab.agentTodoAccessDesc" },
  { tab: "terminal", key: "terminalTab.mcpYolo", descKey: "terminalTab.mcpYoloDesc" },
  { tab: "terminal", key: "terminalTab.idleAutoClose", descKey: "terminalTab.idleAutoCloseDesc" },

  { tab: "appearance", key: "appearance.uiScale", descKey: "appearance.uiScaleDesc" },
  { tab: "appearance", key: "appearance.layout", descKey: "appearance.layoutDesc" },
  { tab: "appearance", key: "appearance.colorByModel", descKey: "appearance.colorByModelDesc" },
  { tab: "appearance", key: "appearance.animations", descKey: "appearance.animationsDesc" },
  { tab: "appearance", key: "appearance.language", descKey: "appearance.languageDesc" },

  { tab: "fastpick", key: "fastpick.settingsTitle", descKey: "fastpick.settingsDesc" },
  { tab: "fastpick", key: "fastpick.enable", descKey: "fastpick.enableDesc" },

  { tab: "experiments", key: "experiments.infoBox", descKey: "experiments.infoBoxDesc" },
  { tab: "experiments", key: "experiments.smartSort", descKey: "experiments.smartSortDesc" },

  { tab: "about", key: "about.title" },
];

/**
 * The DOM id a page gives the control this entry names.
 *
 * Derived from the key rather than written down beside it: two strings that
 * have to agree and are never compared is how half a search index ends up
 * pointing at nothing.
 */
export function settingAnchorId(key: string): string {
  return `setting-${key.replace(/\./g, "-")}`;
}
