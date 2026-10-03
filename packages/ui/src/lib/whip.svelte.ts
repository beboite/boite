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

/** The control must release even while its heavy overlay is still loading. */
export function installWhipEscape(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !whip.held) return;
    whip.held = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
