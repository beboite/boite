import type { PaletteMode } from "./modes";

class PaletteStore {
  open = $state(false);
  /**
   * What it was opened as. Typing a prefix moves the mode for that keystroke
   * without touching this, so backing the prefix out returns here rather than
   * to whatever the last prefix said.
   */
  mode = $state<PaletteMode>("commands");

  show(mode: PaletteMode = "commands") {
    this.mode = mode;
    this.open = true;
  }

  hide() {
    this.open = false;
  }

  /**
   * Same chord twice closes it, a different door reopens it.
   *
   * Without the mode check, pressing the file chord while the command list was
   * up would close the palette instead of switching it, which reads as the
   * shortcut not working.
   */
  toggle(mode: PaletteMode = "commands") {
    if (this.open && this.mode === mode) {
      this.open = false;
      return;
    }
    this.mode = mode;
    this.open = true;
  }
}

export const palette = new PaletteStore();
