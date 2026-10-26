import { tick } from 'svelte';
import { browserAnimatedBack } from './mobile-history';
import { glides } from './motion';

export type SlideDirection = 'push' | 'pop';

/** The keyframes of a slide (`app.css`): the end of one of them is the end of the slide. */
const keyframes = new Set(['screen-in', 'screen-out', 'screen-under-in', 'screen-under-out']);

/**
 * A phone's screen that slides in over the one it opens from, and back off it.
 *
 * `follow` watches which screen shows and starts a slide on a move between
 * two of them. `direction` is set while the slide plays: the markup keeps both
 * screens drawn meanwhile, as children of one element, and `app.css`'s
 * keyframes move them. Nothing slides under reduced motion, nor after a Back
 * the browser animated itself, which already showed the screen underneath
 * (`browserAnimatedBack`).
 *
 * The element whose children are the screens is the stage (`attach`, or
 * `watch` for one the component does not draw): the end of a screen's
 * keyframes on it ends the slide. As with `Closing`, a slide that animates
 * nothing (a page the browser is not painting, a browser without Web
 * Animations) ends one tick after it starts.
 */
export class ScreenSlide {
  #direction = $state<SlideDirection | null>(null);
  #from = $state<string | null>(null);
  #stage: HTMLElement | undefined;
  #run = 0;

  get direction(): SlideDirection | null {
    return this.#direction;
  }

  /** The screen the slide playing leaves. */
  get from(): string | null {
    return this.#from;
  }

  /**
   * From a component's initialisation: follows the screen `current` names
   * (null when none of them shows). A move `way` names slides that way; any
   * other move ends the slide playing.
   */
  follow(current: () => string | null, way: (from: string, to: string) => SlideDirection | null): void {
    let before: string | null = null;
    $effect.pre(() => {
      const next = current();
      const previous = before;
      before = next;
      if (previous === next) return;
      const direction = previous !== null && next !== null ? way(previous, next) : null;
      if (direction && previous !== null) this.go(direction, previous);
      else this.stop();
    });
  }

  /** Starts a slide from the screen `from`, or ends the one playing when this one cannot run: true when it runs. */
  go(direction: SlideDirection, from: string | null = null): boolean {
    this.#run += 1;
    const animates = typeof document !== 'undefined' && typeof document.documentElement.getAnimations === 'function';
    const runs = animates && glides() && !browserAnimatedBack();
    this.#direction = runs ? direction : null;
    this.#from = runs ? from : null;
    if (runs) void this.#settle(this.#run);
    return runs;
  }

  stop(): void {
    this.#run += 1;
    this.#direction = null;
    this.#from = null;
  }

  /** Makes `stage` the element whose children are the screens, until the returned function runs. */
  watch(stage: HTMLElement): () => void {
    this.#stage = stage;
    stage.addEventListener('animationend', this.#end);
    return () => {
      stage.removeEventListener('animationend', this.#end);
      if (this.#stage === stage) this.#stage = undefined;
    };
  }

  /** `use:` on the stage. */
  attach = (node: HTMLElement): { destroy: () => void } => ({ destroy: this.watch(node) });

  /** A screen's end bubbles up to the stage; a deeper element's is not one. */
  #end = (event: AnimationEvent): void => {
    if (keyframes.has(event.animationName) && (event.target as Element | null)?.parentElement === this.#stage) this.stop();
  };

  async #settle(run: number): Promise<void> {
    await tick();
    if (run !== this.#run) return;
    const stage = this.#stage;
    const moving = (stage?.getAnimations({ subtree: true }) ?? []).some(animation =>
      keyframes.has((animation as CSSAnimation).animationName) && (animation.effect as KeyframeEffect | null)?.target?.parentElement === stage);
    if (!moving) this.stop();
  }
}
