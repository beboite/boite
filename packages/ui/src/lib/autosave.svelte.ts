import { errorText } from './errors';

/** How long typing pauses before a text or number field saves. Leaving the field saves at once. */
export const TYPING_MS = 700;

/**
 * `waiting` holds a change for the typing pause, `invalid` a value the form
 * refuses to send, `error` a save the core refused or never answered.
 */
export type SaveState = 'idle' | 'waiting' | 'saving' | 'saved' | 'invalid' | 'error';

/**
 * Saves a setting as soon as it changes, with no Save button. `write` sends
 * what the form holds when it runs, so a change made while a save is in flight
 * waits for it and goes next with the latest value: rapid changes end in one
 * more save, never land out of order, and never race two writes on one
 * revision. A failed write leaves the form as it is and reads as an error with
 * a retry, never as saved.
 */
export class Autosave {
  state = $state<SaveState>('idle');
  error = $state('');
  /** The part of the form that changed last, so the status shows beside it. */
  at = $state('');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private held = false;
  private dirty = false;
  private running: Promise<void> | null = null;

  /**
   * @param write throws when nothing was saved; its message is shown.
   * @param check a reason the form cannot be sent as it is, or null.
   */
  constructor(private readonly write: () => Promise<void>, private readonly check: () => string | null = () => null) {}

  /** A change to save: now, or after `delay` ms of quiet for typing. */
  change(at = '', delay = 0): void {
    this.at = at;
    clearTimeout(this.timer);
    this.held = true;
    if (this.state !== 'saving') this.state = 'waiting';
    if (delay > 0) this.timer = setTimeout(() => void this.flush(), delay);
    else void this.flush();
  }

  /** Saves a held change now: the field lost focus, or the form is leaving. Resolves once nothing is left to save. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.held) { this.held = false; this.dirty = true; }
    if (this.running) return this.running;
    if (!this.dirty) return Promise.resolve();
    this.running = this.drain();
    return this.running;
  }

  /** Sends the form again after an error. */
  retry(): Promise<void> {
    this.dirty = true;
    return this.flush();
  }

  private async drain(): Promise<void> {
    // Lets flush() keep this promise before a loop with nothing to await could end.
    await Promise.resolve();
    try {
      while (this.dirty) {
        this.dirty = false;
        const problem = this.check();
        if (problem) { this.state = 'invalid'; this.error = problem; continue; }
        this.state = 'saving';
        try {
          await this.write();
          if (!this.dirty) { this.state = this.held ? 'waiting' : 'saved'; this.error = ''; }
        } catch (cause) {
          this.error = errorText(cause);
          if (!this.dirty) this.state = 'error';
        }
      }
    } finally { this.running = null; }
  }
}

/** The save a text field's events drive: typing waits for a pause, leaving the field saves. */
export function typed(save: Autosave, at = '') {
  return {
    oninput: () => save.change(at, TYPING_MS),
    onchange: () => void save.flush()
  };
}

/** A switch that saves when it flips: a refused save puts it back where the core still has it. */
export async function toggled(input: HTMLInputElement, save: (checked: boolean) => Promise<boolean>): Promise<void> {
  const checked = input.checked;
  if (!await save(checked)) input.checked = !checked;
}

/** The write of a settings card: `saveSettings` reports a refusal as false, and the card must not read as saved. */
export async function saved(ok: Promise<boolean>): Promise<void> {
  if (!await ok) throw new Error('');
}
