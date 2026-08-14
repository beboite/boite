import type { Keybinding } from "./types";

/**
 * What Boite ships with. This used to be the whole shortcut system, a table of
 * closures in `+layout.svelte`; it is now the seed of the user's own set, and
 * `merge.ts` is what lands a newly added line here in an install that already
 * has rules.
 *
 * The clauses reproduce the scope ladder they replaced. It resolved one scope
 * top-down (`palette > modal > settings > editor > project > app`), so a rule
 * scoped to `app` was silent while any panel or overlay was up, and `!
 * overlayOpen` is that same sentence now that every layer is its own key.
 */

// Every view, but nothing while an overlay owns the keyboard. `View` has
// exactly four values, so this is the old `["app","settings","editor",
// "project"]` spelled once.
const ANY_VIEW = "!overlayOpen";
const TERMINAL_ONLY = "terminalFocus && !overlayOpen";

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  {
    key: "escape",
    command: "view.backToTerminal",
    when: "(settingsOpen || editorFocus || projectFocus) && !overlayOpen",
  },
  { key: "mod+plus", command: "view.zoomIn", when: ANY_VIEW },
  { key: "mod+minus", command: "view.zoomOut", when: ANY_VIEW },
  { key: "mod+digit0", command: "view.zoomReset", when: ANY_VIEW },
  // On macOS these are Cmd only: Ctrl+K is readline's kill-line and the shell
  // needs it. The dispatcher drops a match with a stray Ctrl there.
  //
  // The palette keeps its own keys while it is open, which is why these two are
  // the only defaults that survive `paletteOpen`: Ctrl+K has to close what
  // Ctrl+K opened.
  { key: "mod+k", command: "palette.toggle", when: "!modalOpen" },
  { key: "mod+shift+p", command: "palette.toggle", when: "!modalOpen" },
  // The chord an editor puts file opening on, and it was free here. Boite ships
  // an editor, a tab strip and a diff viewer, and until now the only way to open
  // a file was to open a panel and aim at it with a mouse. Same `!modalOpen` as
  // the palette's own keys, so it can retarget a palette that is already up.
  { key: "mod+p", command: "palette.files", when: "!modalOpen" },
  { key: "mod+b", command: "view.toggleSidebar", when: ANY_VIEW },
  { key: "mod+,", command: "view.toggleSettings", when: ANY_VIEW },
  { key: "mod+tab", command: "thread.next", when: ANY_VIEW },
  { key: "mod+shift+tab", command: "thread.previous", when: ANY_VIEW },
  // Ctrl+Shift+E and Ctrl+Shift+O rather than the editor world's Ctrl+\ for two
  // reasons, both of which the backslash fails on. Ctrl+\ is SIGQUIT: a
  // capture-phase listener that swallows it takes away the only way to quit a
  // wedged process in a terminal, which is not a trade a multiplexer gets to
  // make. And on a French AZERTY the backslash is AltGr+8, so the event carries
  // `code: "Digit8"` with `altKey` set and no rule on it can ever fire.
  { key: "mod+shift+e", command: "pane.splitRight", when: TERMINAL_ONLY },
  { key: "mod+shift+o", command: "pane.splitDown", when: TERMINAL_ONLY },
  { key: "mod+alt+arrowright", command: "pane.next", when: TERMINAL_ONLY },
  { key: "mod+alt+arrowdown", command: "pane.next", when: TERMINAL_ONLY },
  { key: "mod+alt+arrowleft", command: "pane.previous", when: TERMINAL_ONLY },
  { key: "mod+alt+arrowup", command: "pane.previous", when: TERMINAL_ONLY },
  { key: "mod+shift+t", command: "thread.restoreClosed", when: ANY_VIEW },
  { key: "mod+t", command: "thread.new", when: ANY_VIEW },
  { key: "mod+w", command: "view.closeFrontMost", when: ANY_VIEW },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
    key: `mod+digit${n}`,
    command: `thread.jump${n}`,
    when: ANY_VIEW,
  })),
];
