import type { MessageKey } from "$lib/i18n/messages";

/**
 * Every command a rule may name, and the only place their ids are written down.
 *
 * A rule stores an id rather than a closure, so this catalogue is what turns
 * one back into behaviour: the layout supplies the handlers, keyed by these
 * ids, and the settings editor lists these entries whether or not a rule
 * currently claims one.
 */
export type KeyCommandGroup = "view" | "thread" | "pane";

export interface KeyCommandDef {
  id: string;
  group: KeyCommandGroup;
  labelKey: MessageKey;
  labelParams?: Record<string, string | number>;
  /**
   * Single-key rules are skipped while an input, textarea or contenteditable
   * has focus unless this is set. Combos with a modifier always run: the user
   * cannot have meant to type Ctrl+W into the box.
   */
  allowInInput?: boolean;
}

const THREAD_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const KEY_COMMANDS: KeyCommandDef[] = [
  { id: "view.backToTerminal", group: "view", labelKey: "keybindings.cmd.backToTerminal" },
  { id: "view.toggleSettings", group: "view", labelKey: "keybindings.cmd.toggleSettings" },
  { id: "view.toggleSidebar", group: "view", labelKey: "keybindings.cmd.toggleSidebar" },
  { id: "view.closeFrontMost", group: "view", labelKey: "keybindings.cmd.closeFrontMost" },
  { id: "view.zoomIn", group: "view", labelKey: "keybindings.cmd.zoomIn" },
  { id: "view.zoomOut", group: "view", labelKey: "keybindings.cmd.zoomOut" },
  { id: "view.zoomReset", group: "view", labelKey: "keybindings.cmd.zoomReset" },
  { id: "palette.toggle", group: "view", labelKey: "keybindings.cmd.palette" },
  { id: "palette.files", group: "view", labelKey: "keybindings.cmd.goToFile" },
  { id: "thread.new", group: "thread", labelKey: "keybindings.cmd.newThread" },
  { id: "thread.next", group: "thread", labelKey: "keybindings.cmd.nextThread" },
  { id: "thread.previous", group: "thread", labelKey: "keybindings.cmd.previousThread" },
  {
    id: "thread.restoreClosed",
    group: "thread",
    labelKey: "keybindings.cmd.restoreThread",
  },
  ...THREAD_SLOTS.map((n) => ({
    id: `thread.jump${n}`,
    group: "thread" as const,
    labelKey: "keybindings.cmd.jumpToThread" as MessageKey,
    labelParams: { n },
  })),
  { id: "pane.splitRight", group: "pane", labelKey: "keybindings.cmd.splitRight" },
  { id: "pane.splitDown", group: "pane", labelKey: "keybindings.cmd.splitDown" },
  { id: "pane.next", group: "pane", labelKey: "keybindings.cmd.nextPane" },
  { id: "pane.previous", group: "pane", labelKey: "keybindings.cmd.previousPane" },
];

export const KEY_COMMAND_BY_ID: Record<string, KeyCommandDef> = Object.fromEntries(
  KEY_COMMANDS.map((c) => [c.id, c]),
);

export const KEY_COMMAND_GROUPS: { id: KeyCommandGroup; labelKey: MessageKey }[] = [
  { id: "view", labelKey: "keybindings.groupView" },
  { id: "thread", labelKey: "keybindings.groupThread" },
  { id: "pane", labelKey: "keybindings.groupPane" },
];

/**
 * The context keys a clause may name, for the editor's hint list. The parser
 * does not consult it: an unknown key is `false`, so a key added by a later
 * build costs nothing but a missing line here.
 */
export const CONTEXT_KEYS = [
  "terminalFocus",
  "settingsOpen",
  "editorFocus",
  "projectFocus",
  "paletteOpen",
  "modalOpen",
  "overlayOpen",
  "inputFocus",
  "hasThread",
] as const;
