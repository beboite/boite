import { isEditableTarget, matchesCombo } from "./combo";
import type { CompiledRule, KeyCommandRun, KeyContext } from "./types";

/**
 * One capture-phase window listener arbitrates every global shortcut.
 *
 * The alternative — a handler per feature — is what produces the classic
 * double-fire bugs: Escape closing a dialog *and* the panel behind it, two
 * components both claiming Ctrl+W. Capture phase means this runs before any
 * component-level `svelte:window` handler, so it can decide.
 *
 * **The last matching rule wins**, which is the inverse of what this dispatcher
 * used to do and the whole reason a user rule can override a shipped one: the
 * user's set is the defaults with their own rules appended, so position is what
 * says whose Ctrl+T it is. A rule declining with `false` sends the search on to
 * the rules in front of it, so the key is never merely swallowed.
 *
 * Nothing here parses anything. Combos and clauses arrive compiled, because
 * this runs on every keystroke the terminal is also about to receive.
 */

export interface KeyboardControllerOptions {
  rules: () => CompiledRule[];
  /** Read lazily: it probes the DOM, and most keystrokes match no combo. */
  context: () => KeyContext;
  handlers: () => Record<string, KeyCommandRun | undefined>;
  isMac: () => boolean;
  /**
   * Hand the keyboard back while the settings editor is recording a combo.
   *
   * A flag rather than a listener the recorder registers first: listeners on
   * one target in one phase run in registration order, and this one is attached
   * at boot, so nothing mounted later can get in front of it.
   */
  suspended?: () => boolean;
}

export function createKeyboardController(opts: KeyboardControllerOptions) {
  function handleKeydown(event: KeyboardEvent) {
    if (opts.suspended?.()) return;
    const rules = opts.rules();
    if (rules.length === 0) return;
    const isMac = opts.isMac();
    const editable = isEditableTarget(event.target);
    let ctx: KeyContext | null = null;
    let handlers: Record<string, KeyCommandRun | undefined> | null = null;

    for (let i = rules.length - 1; i >= 0; i -= 1) {
      const rule = rules[i];
      if (!rule.valid) continue;
      if (!matchesCombo(rule.combo, event, isMac)) continue;
      // Modifier combos are safe inside inputs; bare keys are not.
      const bare = !rule.combo.mod && !rule.combo.alt;
      if (editable && bare && !rule.allowInInput) continue;
      ctx ??= opts.context();
      if (!rule.test(ctx)) continue;
      handlers ??= opts.handlers();
      // A rule naming a command this build does not have is inert rather than
      // fatal: an older Boite reading a set a newer one wrote must still boot.
      const run = handlers[rule.binding.command];
      if (!run) continue;
      if (run(event) === false) continue;
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
