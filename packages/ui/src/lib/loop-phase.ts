/** A 60th of a second on the document's timeline: the grid every endless loop starts on. */
export const LOOP_TICK_MS = 1000 / 60;

const endless = (animation: Animation): boolean =>
  'animationName' in animation && animation.effect?.getTiming().iterations === Infinity;

/** Moves a playing loop's start onto the grid, by half a tick at most. */
export function alignLoop(animation: Animation): void {
  const start = animation.startTime;
  if (typeof start !== 'number') return;
  const aligned = Math.round(start / LOOP_TICK_MS) * LOOP_TICK_MS;
  if (Math.abs(aligned - start) > 0.001) animation.startTime = aligned;
}

const alignOnceReady = (animation: Animation) => void animation.ready.then(() => alignLoop(animation), () => undefined);

/** Every endless loop of the page back on the grid, once each plays again. */
export function alignLoops(doc: Document = document): void {
  // A DOM without Web Animations, as under test, runs no loop to align.
  if (typeof doc.getAnimations !== 'function') return;
  for (const animation of doc.getAnimations()) if (endless(animation)) alignOnceReady(animation);
}

/**
 * A loop eased down a staircase or in `steps()` (app.css) changes on a 60 Hz
 * grid of its own start, and each row starts its loop when it mounts: sixteen
 * spinners out of phase still change on most refreshes of a fast monitor.
 * Starting each one on the same grid makes them step together, and the
 * compositor draws only the 60 frames a second in which something moved.
 * `lib/at-rest.ts` aligns them again when they resume, since a paused loop
 * resumes from wherever the pause found it. Returns the way to stop.
 */
export function watchLoopPhase(doc: Document = document): () => void {
  const started = (event: AnimationEvent) => {
    if (!(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations({ subtree: true })) {
      if (endless(animation) && (animation as CSSAnimation).animationName === event.animationName) alignOnceReady(animation);
    }
  };
  doc.addEventListener('animationstart', started);
  return () => doc.removeEventListener('animationstart', started);
}
