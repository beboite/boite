/** Shared by the desktop and phone controls; the overlay owns the rope. */
class Whip {
  held = $state(false);
  x = 0;
  y = 0;

  throw(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.held = true;
  }
}

export const whip = new Whip();
