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

  /** `onanimationend` or `ontransitionend` on that same node: unmount once the exit is over. */
  end = (event: AnimationEvent | TransitionEvent): void => {
    if (event.target !== event.currentTarget) return;
    if (this.#raw === 'closing') this.#go('closed');
  };

  #go(phase: Phase): void {
    this.#raw = phase;
    this.#phase = phase;
  }

  /**
   * A test environment has no animation engine, so a node with no running
   * animation is unmounted one tick after the exit starts. Otherwise
   * `animationend` is not promised: a cancelled exit sends `animationcancel`
   * instead, and a page the browser draws no frame of ends nothing (a phone
   * tour stayed on screen after Done on a busy CI runner). Each exit's own
   * `finished`, settled either way, unmounts the node; two seconds past its
   * length, a page still drawing nothing lets it go without the exit. A busy
   * runner can take longer than the exit itself to draw its first frame, so
   * a deadline at its length cut the right panel's slide before it began.
   */
  async #settle(run: number): Promise<void> {
    await tick();
    if (run !== this.#run || this.#raw !== 'closing') return;
    const node = this.#node;
    const running = node && typeof node.getAnimations === 'function' ? node.getAnimations() : [];
    const exits = running.filter((animation) => Number.isFinite(endOf(animation)));
    if (exits.length > 0) {
      const length = Math.max(...exits.map(endOf));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(exits.map((animation) => animation.finished)),
        new Promise((resolve) => { timer = setTimeout(resolve, length + EXIT_SLACK_MS); })
      ]);
      clearTimeout(timer);
      if (run !== this.#run || this.#raw !== 'closing') return;
    }
    this.#go('closed');
  }
}

/** How long past an exit's length a page may draw no frame before the node goes without it. */
const EXIT_SLACK_MS = 2000;

/** When an animation ends, in ms from its start; infinite for one that loops. */
function endOf(animation: Animation): number {
  return Number(animation.effect?.getComputedTiming().endTime ?? 0);
}
