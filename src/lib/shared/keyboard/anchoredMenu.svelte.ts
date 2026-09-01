import { tick } from "svelte";
import { registerEscape, restoreFocus, viewportHeight } from "./overlay";

/**
 * A dropdown that hangs off a trigger in the shortcut bar.
 *
 * Fixed positioning rather than absolute: the bar scrolls sideways, which clips
 * an absolutely-positioned surface inside it. So the surface is drawn at
 * viewport coordinates, and something has to keep those coordinates honest while
 * the window resizes, a soft keyboard opens, or the bar scrolls. That, Escape,
 * where focus goes back to, and closing on a click elsewhere are the whole of
 * what every one of these pickers needs and none of them is about.
 *
 * Instantiated at the top of a component's `<script>`, never later: the effects
 * are registered in the constructor and need the component's own init context,
 * the same way `rowFlip` needs the action's.
 */

/** How close to a viewport edge the surface may come. */
const EDGE_GAP = 4;

/** The gap between the trigger and the surface, either side of it. */
const TRIGGER_GAP = 4;

export class AnchoredMenu {
  /** Whether the surface is up. Assign to it to open or close. */
  open = $state(false);
  /** The trigger's box, which the surface is measured against. `bind:this` it. */
  trigger = $state<HTMLElement | null>(null);
  /** The surface itself, once the `{#if}` has drawn it. `bind:this` it. */
  surface = $state<HTMLElement | null>(null);
  /** Where to draw it, in viewport coordinates. */
  pos = $state({ x: 0, y: 0 });

  /** Called once the surface exists, for a menu that moves focus into it. */
  readonly #opened: ((surface: HTMLElement) => void) | null;

  constructor(opened?: (surface: HTMLElement) => void) {
    this.#opened = opened ?? null;

    $effect(() => {
      if (!this.open) return;
      void this.place();
      const replace = () => void this.place();
      window.addEventListener("resize", replace);
      // A soft keyboard shrinks the visual viewport without necessarily resizing
      // the window, and it is the room under the trigger that changed.
      window.visualViewport?.addEventListener("resize", replace);
      return () => {
        window.removeEventListener("resize", replace);
        window.visualViewport?.removeEventListener("resize", replace);
      };
    });

    $effect(() => {
      if (!this.open) return;
      return registerEscape(() => (this.open = false));
    });

    $effect(() => {
      if (!this.open) return;
      const previous = document.activeElement as HTMLElement | null;
      const surface = this.surface;
      if (surface) this.#opened?.(surface);
      return () => restoreFocus(previous, surface);
    });

    // `pointerdown`, not `click`, for two reasons that both cost a bug. Picking
    // a harness swaps the pane, and the browser runs a microtask checkpoint
    // between listeners, so Svelte has already detached the clicked row by the
    // time a document-level `click` looks at it: the menu read its own item as an
    // outside click and closed on every step. And a right-click never fires a
    // `click` at all, so a right-click on the button beside an open dropdown
    // raised a context menu with the dropdown still up, two menus on one point.
    $effect(() => {
      const outside = (e: PointerEvent) => {
        if (!this.open) return;
        const target = e.target as Node;
        if (this.trigger?.contains(target) || this.surface?.contains(target)) return;
        this.open = false;
      };
      document.addEventListener("pointerdown", outside);
      return () => document.removeEventListener("pointerdown", outside);
    });
  }

  /** What a trigger's `onclick` does: opens where it stands, or closes. */
  toggle(e: MouseEvent): void {
    e.stopPropagation();
    if (!this.open) this.#anchor();
    this.open = !this.open;
  }

  /**
   * Puts the surface where it fits, and calls it again whenever what it
   * contains has changed size.
   */
  async place(): Promise<void> {
    this.#anchor();
    await tick();
    const surface = this.surface;
    const trigger = this.trigger;
    if (!surface || !trigger) return;
    const r = trigger.getBoundingClientRect();
    // Layout box, not the painted one: the open transition scales the surface,
    // and a measurement taken mid-transition is smaller than what has to fit.
    const w = surface.offsetWidth;
    const h = surface.offsetHeight;
    const vw = window.innerWidth;
    const vh = viewportHeight();
    const below = r.bottom + TRIGGER_GAP;
    this.pos = {
      // The trigger lives in a bar that scrolls sideways, so near the right edge
      // the surface used to run off screen.
      x: Math.max(EDGE_GAP, Math.min(r.left, vw - w - EDGE_GAP)),
      // Flipped above the trigger rather than clamped when the room below is
      // gone: a clamp alone parks the surface over the button that opened it.
      y: below + h + EDGE_GAP <= vh ? below : Math.max(EDGE_GAP, r.top - TRIGGER_GAP - h),
    };
  }

  /**
   * First guess, taken before the surface exists. `place` refines it once there
   * is something to measure, and until then this is what stops the surface from
   * being painted at the top left corner for one frame.
   */
  #anchor(): void {
    if (!this.trigger) return;
    const r = this.trigger.getBoundingClientRect();
    this.pos = { x: r.left, y: r.bottom + TRIGGER_GAP };
  }
}
