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
 * `catalogue.test.ts` fails when an entry names a key no page anchors, and when
 * a page draws a control it never anchored: those are the two ways this rots,
 * and both leave a setting unfindable while everything still compiles.
 */

/**
 * The pages of the settings panel, in the order the rail draws them.
 *
 * Eleven of them was the problem: "CLIs" and "plugins" were the same question
 * asked twice (what can this machine run, under which account), "devices" and
 * "sync" were both about the other computers, and "logs" spent a permanent
 * line on a page nobody opens until something has gone wrong. Eight now, and
 * the list lives here rather than in `SettingsPanel` so the test that walks the
 * pages reads the same one the panel does.
 */
export const SETTINGS_TABS = [
  "general",
  "terminal",
  "appearance",
  "agents",
  "keyboard",
  "machines",
  "experiments",
  "about",
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number];

/**
 * What has to be true for a page to draw the control an entry names.
 *
 * A name rather than a function, so this file stays a plain list with no store
 * behind it and the test can read it in Node. `SettingsPanel` is where the
 * stores are and where the name is answered.
 */
export type SettingCondition = "push" | "windowsHost" | "pairing";

export interface SettingEntry {
  tab: SettingsTabId;
  /** The control's own label key, which is also its anchor. */
  key: MessageKey;
  /** The sentence under it, searched too: it holds the words nobody guesses. */
  descKey?: MessageKey;
  /**
   * Set on the controls their page only draws sometimes, so search can drop
   * them when it does not. Without it, "powershell" on a Linux desktop answers
   * with three hits that jump to the terminal page and highlight nothing,
   * because the card they name lives inside `{#if platform.isHostWindows}`.
   */
  when?: SettingCondition;
}

export const SETTINGS_CATALOGUE: SettingEntry[] = [
  { tab: "general", key: "general.openOnLaunch", descKey: "general.openOnLaunchDesc" },
  { tab: "machines", key: "sync.enable", descKey: "sync.enableDesc" },
  { tab: "machines", key: "sync.remoteTitle", descKey: "sync.remoteDesc" },
  { tab: "machines", key: "sync.statusTitle", descKey: "sync.statusDesc" },
  { tab: "machines", key: "sync.sourcesTitle", descKey: "sync.sourcesDesc" },

  { tab: "general", key: "general.pushTitle", descKey: "general.pushDesc", when: "push" },
  { tab: "general", key: "shortcuts.title", descKey: "shortcuts.description" },

  { tab: "terminal", key: "terminalTab.defaultShell", descKey: "terminalTab.defaultShellDesc" },
  { tab: "terminal", key: "terminalTab.windowsTweaks", when: "windowsHost" },
  {
    tab: "terminal",
    key: "terminalTab.psNewline",
    descKey: "terminalTab.psNewlineDesc",
    when: "windowsHost",
  },
  {
    tab: "terminal",
    key: "terminalTab.psNoProfile",
    descKey: "terminalTab.psNoProfileDesc",
    when: "windowsHost",
  },
  { tab: "terminal", key: "terminalTab.threadClose" },
  { tab: "terminal", key: "terminalTab.confirmClose", descKey: "terminalTab.confirmCloseDesc" },
  { tab: "terminal", key: "terminalTab.gitAutoFetch" },
  { tab: "terminal", key: "terminalTab.autoFetch", descKey: "terminalTab.autoFetchDesc" },
  { tab: "terminal", key: "terminalTab.agentLaunch" },
  { tab: "terminal", key: "terminalTab.threadWorktrees", descKey: "terminalTab.threadWorktreesDesc" },
  { tab: "terminal", key: "terminalTab.agentTodoAccess", descKey: "terminalTab.agentTodoAccessDesc" },
  { tab: "terminal", key: "terminalTab.mcpYolo", descKey: "terminalTab.mcpYoloDesc" },
  { tab: "terminal", key: "terminalTab.idleAutoClose", descKey: "terminalTab.idleAutoCloseDesc" },

  { tab: "appearance", key: "appearance.theme", descKey: "appearance.themeDesc" },
  { tab: "appearance", key: "appearance.uiScale", descKey: "appearance.uiScaleDesc" },
  { tab: "appearance", key: "appearance.fonts", descKey: "appearance.fontsDesc" },
  {
    tab: "appearance",
    key: "appearance.terminalSize",
    descKey: "appearance.terminalSizeDesc",
  },
  { tab: "appearance", key: "appearance.layout", descKey: "appearance.layoutDesc" },
  { tab: "appearance", key: "appearance.colorByModel", descKey: "appearance.colorByModelDesc" },
  { tab: "appearance", key: "appearance.animations", descKey: "appearance.animationsDesc" },
  { tab: "appearance", key: "appearance.language", descKey: "appearance.languageDesc" },

  // Drawn only where a boite-server answers for pairing; on a desktop the
  // machines page is the sync page alone.
  { tab: "machines", key: "devices.title", descKey: "devices.description", when: "pairing" },
  {
    tab: "machines",
    key: "devices.inviteTitle",
    descKey: "devices.inviteDesc",
    when: "pairing",
  },

  { tab: "agents", key: "cli.title", descKey: "cli.description" },
  // The cards themselves left for `PluginsPage.svelte`; what stays here is the
  // row that opens it, so searching settings for "plugins" still lands somewhere.
  { tab: "agents", key: "plugins.title", descKey: "plugins.movedDesc" },


  { tab: "experiments", key: "experiments.home", descKey: "experiments.homeDesc" },
  {
    tab: "experiments",
    key: "experiments.orchestrator",
    descKey: "experiments.orchestratorDesc",
  },
  {
    tab: "experiments",
    key: "experiments.orchestratorPerProject",
    descKey: "experiments.orchestratorPerProjectDesc",
  },
  // The voice sub-controls live in VoiceSettings.svelte, outside this
  // directory's scan, so the experiment row is the search's landing spot.
  { tab: "experiments", key: "experiments.voice", descKey: "experiments.voiceDesc" },
  { tab: "experiments", key: "experiments.infoBox", descKey: "experiments.infoBoxDesc" },
  { tab: "experiments", key: "experiments.smartSort", descKey: "experiments.smartSortDesc" },
  { tab: "experiments", key: "experiments.whip", descKey: "experiments.whipDesc" },
  {
    tab: "experiments",
    key: "experiments.sidebarDesign",
    descKey: "experiments.sidebarDesignDesc",
  },
  // The logo row's description changes with the design above it; search reads
  // the glow one, which is the sentence that says what the setting does.
  {
    tab: "experiments",
    key: "experiments.harnessLogos",
    descKey: "experiments.harnessLogosDesc",
  },

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
