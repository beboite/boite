import { tick } from 'svelte';

type Phase = 'closed' | 'open' | 'closing';

/**
 * A popover or an overlay that closes the way it opened.
 *
 * `shown` stays true one `--dur-2` after `hide()`, `closing` is on while the
 * reverse animation plays, and the node leaves the DOM on `animationend`.
 * Opening again inside that window cancels the exit instead of queueing a
 * second one: the animation name flips back and restarts.
 *
 * Usage on the node that carries the animation:
 *
 *     {#if popover.shown}
 *       <div class="popover" class:closing={popover.closing}
 *            use:popover.attach onanimationend={popover.end}>
 *
 * with `.popover.closing { animation-name: pop-out }` beside the entrance rule.
 */
export class Closing {
  /**
   * Read by the markup. The plain mirror beside it is what the methods test,
   * so calling one from inside an `$effect` subscribes that effect to nothing.
   */
  #phase = $state<Phase>('closed');
  #raw: Phase = 'closed';
  #node: HTMLElement | undefined;
  #run = 0;

  get open(): boolean {
    return this.#phase === 'open';
  }

  get closing(): boolean {
    return this.#phase === 'closing';
  }

  /** True while the node belongs in the DOM: open, or playing its exit. */
  get shown(): boolean {
    return this.#phase !== 'closed';
  }

  show(): void {
    this.#run += 1;
    this.#go('open');
  }

  hide(): void {
    if (this.#raw !== 'open') return;
    this.#go('closing');
    this.#run += 1;
    void this.#settle(this.#run);
  }

  toggle(): void {
    if (this.#raw === 'open') this.hide();
    else this.show();
  }

  /** `use:` on the node that carries the animation. */
  attach = (node: HTMLElement): { destroy: () => void } => {
    this.#node = node;
    return {
      destroy: () => {
        if (this.#node === node) this.#node = undefined;
      }
    };
  };

  /** `onanimationend` on that same node: the exit is over, so unmount. */
  end = (event: AnimationEvent): void => {
    if (event.target !== event.currentTarget) return;
    if (this.#raw === 'closing') this.#go('closed');
  };

  #go(phase: Phase): void {
    this.#raw = phase;
    this.#phase = phase;
  }

  /**
   * A node the browser is not painting animates nothing, and a test
   * environment has no animation engine at all, so `animationend` would never
   * come. One tick after the exit starts, a node with no running animation is
   * unmounted on the spot.
   */
  async #settle(run: number): Promise<void> {
    await tick();
    if (run !== this.#run || this.#raw !== 'closing') return;
    const node = this.#node;
    const running = node && typeof node.getAnimations === 'function' ? node.getAnimations() : [];
    if (running.length === 0) this.#go('closed');
  }
}
