import { isDeviceMacOS } from "$lib/storage/platform.svelte";

/**
 * How long the modifier has to sit there before the numbers appear.
 *
 * Every plain `mod+` chord in the app starts with this key down: mod+k opens
 * the palette, mod+t a terminal, mod+w closes one. Without a dwell the sidebar
 * numbers itself behind every one of them, for the few frames it takes to press
 * the second key. Nobody holds a modifier this long on the way to a chord, and
 * anybody reading the hints holds it far longer.
 */
const DWELL_MS = 200;

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
export class JumpModifier {
  down = $state(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The device answer is injected the way the keyboard controller takes its
   * `isMac`, so a test can drive both platforms without a device to ask.
   */
  constructor(private readonly isMac: boolean = isDeviceMacOS) {}

  /**
   * Whether this event describes the jump modifier held on its own.
   *
   * Read off the modifier flags every event carries rather than remembered, so
   * there is no state to get stuck: a key repeat, a chord release and the
   * release of the modifier itself all answer from the same three booleans.
   *
   * Alt and Shift disqualify it because Ctrl+Shift+P is on its way to a
   * command, and lighting the sidebar up under it is a flash on every chord in
   * the app. Meta disqualifies it off macOS for the same reason: Ctrl+Cmd is
   * nobody's jump key. Keyup asks this exact question too, or a chord relights
   * the sidebar the moment its letter comes up while the modifiers stay down.
   */
  private heldAlone(e: KeyboardEvent): boolean {
    if (e.altKey || e.shiftKey) return false;
    return this.isMac ? e.metaKey : e.ctrlKey && !e.metaKey;
  }

  private set(held: boolean): void {
    if (!held) {
      this.cancel();
      this.down = false;
      return;
    }
    // Lit already, or already counting towards it: leave the clock alone. Every
    // event that arrives with the modifier still down asks again, and restarting
    // here would push the numbers a fresh 200ms away for as long as someone
    // keeps typing under it.
    if (this.down || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.down = true;
    }, DWELL_MS);
  }

  private cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // Public so the tests can drive the machine directly: the events this reads
  // are window-level and the test run has no DOM to dispatch them into.
  onKeyDown = (e: KeyboardEvent): void => {
    // Windows and Chromium auto-repeat a lone modifier keydown, so holding the
    // key delivers a stream of `repeat` events for as long as it is held. They
    // say nothing a first keydown did not, and answering them is how an earlier
    // version blanked the numbers half a second into every hold.
    if (e.repeat) return;
    this.set(this.heldAlone(e));
  };

  onKeyUp = (e: KeyboardEvent): void => {
    this.set(this.heldAlone(e));
  };

  // A chord that switches windows (Alt+Tab, Cmd+Tab) takes the keyup with it,
  // and the numbers would stay lit over an app nobody is using.
  onBlur = (): void => {
    this.set(false);
  };

  // A screen lock or an OS-level focus theft can hide the window without the
  // window ever hearing a blur, which is the same stuck keyup by another road.
  onVisibility = (): void => {
    if (document.hidden) this.set(false);
  };

  /** Called once by the layout. Returns a cleanup. */
  watch(): () => void {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
    return () => {
      window.removeEventListener("keydown", this.onKeyDown, { capture: true });
      window.removeEventListener("keyup", this.onKeyUp, { capture: true });
      window.removeEventListener("blur", this.onBlur);
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.set(false);
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
