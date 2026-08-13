import { isDeviceMacOS } from "$lib/storage/platform.svelte";

/**
 * Whether the jump modifier is being held right now.
 *
 * Ctrl+1 to Ctrl+9 jump to a thread by its position in the project, and nothing
 * on screen ever said which thread wore which number. A positional shortcut
 * nobody can see is one nobody learns: it works from the first day for whoever
 * wrote it and is never discovered by anyone else.
 *
 * So the numbers appear while the modifier is down and go when it comes up.
 * Held here rather than in the sidebar because it is a fact about the keyboard,
 * not about a list, and because the events it needs are on the window: a
 * modifier pressed while a terminal has focus never reaches a component.
 *
 * The same key the bindings use, which is Command on macOS and Ctrl elsewhere,
 * read off the device rather than off the boite the window is connected to.
 */
class JumpModifier {
  down = $state(false);

  private onKeyDown = (e: KeyboardEvent) => {
    // Only the modifier alone. Ctrl+Shift+P is on its way to a command, and
    // lighting the sidebar up under it is a flash on every chord in the app.
    if (e.repeat || e.altKey || e.shiftKey) {
      this.down = false;
      return;
    }
    this.down = isDeviceMacOS ? e.metaKey : e.ctrlKey && !e.metaKey;
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down = isDeviceMacOS ? e.metaKey : e.ctrlKey;
  };

  // A chord that switches windows (Alt+Tab, Cmd+Tab) takes the keyup with it,
  // and the numbers would stay lit over an app nobody is using.
  private onBlur = () => {
    this.down = false;
  };

  /** Called once by the layout. Returns a cleanup. */
  watch(): () => void {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    window.addEventListener("blur", this.onBlur);
    return () => {
      window.removeEventListener("keydown", this.onKeyDown, { capture: true });
      window.removeEventListener("keyup", this.onKeyUp, { capture: true });
      window.removeEventListener("blur", this.onBlur);
      this.down = false;
    };
  }
}

export const jumpModifier = new JumpModifier();

/** How many positions the digits reach. */
export const JUMP_SLOTS = 9;

/** The digit that jumps to this row, or null past the ninth. */
export function jumpDigit(index: number): number | null {
  return index < JUMP_SLOTS ? index + 1 : null;
}
