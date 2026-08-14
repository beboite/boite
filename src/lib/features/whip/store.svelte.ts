/**
 * What the titlebar button and the overlay say to each other.
 *
 * Two counters rather than one boolean: the overlay owns whether a rope exists
 * (it is the only thing holding one), and a button that wrote that state
 * directly would have to be mounted for the rope to survive. Here the button
 * asks, the overlay answers by setting `active`, and neither imports the
 * other's chunk — which is what keeps the canvas and its physics out of the
 * boot graph while the experiment is off.
 */
class WhipStore {
  /** Bumped to ask for a rope. */
  spawns = $state(0);
  /** Bumped to let go of the one on screen. */
  drops = $state(0);
  /** Written by the overlay: a rope is on screen right now. */
  active = $state(false);

  /** The button, and anything else that wants the whip out. */
  toggle() {
    if (this.active) this.drops++;
    else this.spawns++;
  }
}

export const whip = new WhipStore();
