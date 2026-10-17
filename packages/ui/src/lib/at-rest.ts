import { shellPresence, watchAttention, type PresenceSource } from './attention';
import { alignLoops } from './loop-phase';

/** How long without a key or a mouse move, anywhere on the system in the shell, puts the window at rest. */
export const REST_IDLE_MS = 120_000;

/**
 * Pauses the app's endless animations while nobody can be watching them: the
 * page hidden, another application in front of a window left visible beside
 * it, or nobody at the PC for `REST_IDLE_MS`. A composited loop, a spinner of
 * a few pixels, keeps the compositor drawing every frame at the monitor's
 * rate for as long as it is on screen, and sixteen working threads put one on
 * every row of the list.
 *
 * Marks `<html data-at-rest>`; `app.css` turns `--loops` to `paused` there and
 * every endless animation reads its play state from it (`render-cost.test.ts`).
 * The answer is `watchAttention`'s, with the longer idle time: in the desktop
 * shell, the window in front and the system's last input (`user_presence`),
 * since a webview's own focus moves to a browser surface of the same window
 * and can stay true behind other windows. Any use of the page, or the window
 * brought to front, plays them again at once, back on the grid of
 * `lib/loop-phase.ts`. Returns the way to stop.
 */
export function watchRest(root: HTMLElement = document.documentElement, presence: PresenceSource | null = shellPresence()): () => void {
  const stop = watchAttention((attentive) => {
    const resumed = attentive && root.hasAttribute('data-at-rest');
    root.toggleAttribute('data-at-rest', !attentive);
    if (resumed) alignLoops(root.ownerDocument);
  }, undefined, presence, REST_IDLE_MS);
  return () => {
    stop();
    root.removeAttribute('data-at-rest');
  };
}
