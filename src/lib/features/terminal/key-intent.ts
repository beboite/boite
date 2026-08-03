/**
 * What a key pressed inside a terminal means, before anything is done about it.
 *
 * This is the layer where getting a branch wrong means Ctrl+C interrupts an
 * agent that was two minutes into a task instead of copying the line the user
 * had selected — or the other way round, which is worse. It lived inside
 * `Terminal.svelte`'s `attachCustomKeyEventHandler` as fifty-five lines of
 * nested conditions reachable only through a mounted terminal with a live PTY,
 * so none of it had a test.
 *
 * The decision comes out; the doing stays. `Terminal.svelte` still owns the
 * clipboard, the PTY write and the focus dance, because those are effects on a
 * component's own state and moving them somewhere else buys nothing.
 */

/** Everything about the world this decision depends on. */
export interface KeyContext {
  /** Cmd is the modifier on macOS, and the palette moves with it. */
  isMacOS: boolean;
  /**
   * Whether the terminal currently has text selected.
   *
   * A function, not a boolean, and that is not style. This runs on every
   * keydown the terminal receives — every character an agent's user types — and
   * asking xterm for its selection is a call into the emulator. Exactly one
   * branch needs the answer, so exactly one branch asks for it.
   */
  hasSelection: () => boolean;
}

/**
 * What should happen, in the caller's vocabulary rather than xterm's.
 *
 * - `pass` hands the key to the shell, which is the default and the common case.
 * - `swallow` stops it reaching the shell and does nothing else: the window's
 *   own handler is still bubbling and will pick it up.
 */
export type KeyIntent =
  | "copy"
  | "copy-and-clear"
  | "paste"
  | "restore-thread"
  | "line-feed"
  | "swallow"
  | "pass";

/**
 * Reads a keydown.
 *
 * `event.code` rather than `event.key`: the physical key is what a shortcut is
 * bound to, and `key` changes with the keyboard layout, so a French layout
 * would have moved every one of these.
 *
 * `lineFeed` is passed in already decided, because whether Shift+Enter sends a
 * line feed depends on which agent is running and on a setting, and neither of
 * those is a property of the keyboard.
 */
export function keyIntent(
  e: Pick<KeyboardEvent, "type" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  context: KeyContext,
  lineFeed: boolean,
): KeyIntent {
  if (e.type !== "keydown") return "pass";
  const { code, ctrlKey, shiftKey, altKey, metaKey } = e;
  const plainCtrl = ctrlKey && !shiftKey && !altKey;

  if (ctrlKey && shiftKey && code === "KeyC") return "copy";
  if (ctrlKey && shiftKey && code === "KeyV") return "paste";

  // The one that has to be right. Ctrl+C with something selected is a copy;
  // with nothing selected it is an interrupt and belongs to the shell, because
  // that is the only way to stop a runaway process. Selection first, and the
  // selection is cleared afterwards so the next Ctrl+C interrupts.
  if (plainCtrl && code === "KeyC") {
    return context.hasSelection() ? "copy-and-clear" : "pass";
  }
  if (plainCtrl && code === "KeyV") return "paste";

  if (ctrlKey && shiftKey && !altKey && code === "KeyT") return "restore-thread";

  // Command palette combos never reach the shell; the window's keydown handler
  // is still bubbling and opens it. On macOS the palette is Cmd+K, so Ctrl+K
  // stays with the shell — it is readline's kill-line, and swallowing it there
  // would break editing a command in every shell on the machine.
  if (plainCtrl && code === "KeyK" && !context.isMacOS) return "swallow";
  if (metaKey && !shiftKey && !altKey && code === "KeyK" && context.isMacOS) return "swallow";
  if (ctrlKey && shiftKey && !altKey && code === "KeyP") return "swallow";

  if (lineFeed) return "line-feed";

  return "pass";
}
