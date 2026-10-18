/*
 * A shell's command status and directory, read from its raw output for the
 * session's whole life, whether an xterm draws that output or not
 * (`terminal-session.svelte.ts`). xterm's own handlers only draw the dots.
 */

import { OscScanner, parsePromptMark, reportedCwd } from './terminal-marks';

/**
 * Prompt, run and end marks held while a snapshot is on its way. A shell
 * marks each command three times, so past this many in one round trip only
 * the oldest commands' marks go, and the newer ones decide the status.
 */
const MAX_HELD = 1000;

export interface ShellStatus {
  running(running: boolean): void;
  exit(code: number | null): void;
  cwd(path: string): void;
}

export class ShellStatusReader {
  #scanner = this.#newScanner();
  /**
   * False until the status was read from a snapshot, or again after the
   * socket dropped. Meanwhile the scanner's reports are held with the
   * sequence of their event, and the seed keeps those the snapshot misses.
   */
  #seeded = false;
  #heldMarks: { sequence: number | undefined; data: string }[] = [];
  /** Only the newest directory report counts, whichever side of the snapshot it is on. */
  #heldCwd: { sequence: number | undefined; cwd: string } | null = null;
  /** The newest sequence read before the seed. */
  #newest: number | undefined;
  /** The sequence of the event the scanner reads. */
  #reading: number | undefined;
  /** After the seed, the last output sequence read: an older one is in the snapshot. */
  #seen: number | undefined;
  /** Where the last command is: at its prompt, running, or neither. */
  #phase: 'idle' | 'prompt' | 'running' = 'idle';

  constructor(private readonly status: ShellStatus) {}

  get seeded(): boolean {
    return this.#seeded;
  }

  /** Output was lost with the socket: the next snapshot seeds the status again. */
  unseed(): void {
    this.#seeded = false;
  }

  /** One output event as it arrives, unless the snapshot the seed read already held it. */
  read(data: string, sequence: number | undefined): void {
    if (this.#seeded && sequence !== undefined && this.#seen !== undefined && sequence <= this.#seen) return;
    this.#reading = sequence;
    this.#scanner.feed(data);
    if (sequence === undefined) return;
    if (this.#seeded) this.#seen = sequence;
    else this.#newest = Math.max(this.#newest ?? sequence, sequence);
  }

  /**
   * The status from `output`, a snapshot up to `sequence`, then from the
   * reports held since that the snapshot does not hold.
   */
  seed(output: string, sequence: number | undefined): void {
    const newer = (held: number | undefined) => held === undefined || sequence === undefined || held > sequence;
    this.#seeded = true;
    this.#phase = 'idle';
    this.status.running(false);
    const snapshot = this.#newScanner();
    snapshot.feed(output);
    for (const mark of this.#heldMarks) if (newer(mark.sequence)) this.#report(133, mark.data);
    if (this.#heldCwd !== null && newer(this.#heldCwd.sequence)) this.status.cwd(this.#heldCwd.cwd);
    // Nothing newer read yet: the next output follows the snapshot, and ends a sequence it left open.
    if (sequence !== undefined && (this.#newest === undefined || this.#newest <= sequence)) this.#scanner = snapshot;
    this.#seen = sequence === undefined ? this.#newest : Math.max(sequence, this.#newest ?? sequence);
    this.#heldMarks = [];
    this.#heldCwd = null;
    this.#newest = undefined;
  }

  #newScanner(): OscScanner {
    return new OscScanner((code, data) => {
      if (this.#seeded) this.#report(code, data);
      else this.#hold(code, data);
    });
  }

  /** What a report before the seed says about the status, kept with the sequence of its event. */
  #hold(code: number, data: string): void {
    const sequence = this.#reading;
    if (code === 133) {
      const kind = parsePromptMark(data)?.kind;
      if (kind !== 'prompt' && kind !== 'run' && kind !== 'done') return;
      if (this.#heldMarks.push({ sequence, data }) > MAX_HELD) this.#heldMarks.shift();
      return;
    }
    const cwd = reportedCwd(code, data);
    if (cwd !== null) this.#heldCwd = { sequence, cwd };
  }

  /** One OSC of the shell's output: its command status and its directory. */
  #report(code: number, data: string): void {
    if (code === 133) {
      const mark = parsePromptMark(data);
      if (mark?.kind === 'prompt') {
        this.#phase = 'prompt';
        this.status.running(false);
      } else if (mark?.kind === 'run' && this.#phase === 'prompt') {
        this.#phase = 'running';
        this.status.running(true);
      } else if (mark?.kind === 'done') {
        this.status.running(false);
        if (this.#phase !== 'running') return;
        this.#phase = 'idle';
        this.status.exit(mark.exit);
      }
      return;
    }
    const cwd = reportedCwd(code, data);
    if (cwd !== null) this.status.cwd(cwd);
  }
}
