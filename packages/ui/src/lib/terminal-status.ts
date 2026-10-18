/*
 * A shell's command status and directory, read from its raw output for the
 * session's whole life, whether an xterm draws that output or not
 * (`terminal-session.svelte.ts`). xterm's own handlers only draw the dots.
 */

import { MAX_OSC, OscScanner, parsePromptMark, reportedCwd, type ShellMark } from './terminal-marks';

/**
 * Output kept while a snapshot is on its way, in characters: as much as the
 * core's snapshot holds, so the seed can parse what follows the snapshot as
 * its continuation.
 */
const MAX_EARLY = 256 * 1024;

type Phase = 'idle' | 'prompt' | 'running';
const PHASES: readonly Phase[] = ['idle', 'prompt', 'running'];

/** The phase after a mark, with the status of the command it ends. `running` is the running phase. */
function after(phase: Phase, mark: ShellMark): { phase: Phase; exit?: number | null } {
  switch (mark.kind) {
    case 'prompt': return { phase: 'prompt' };
    case 'run': return { phase: phase === 'prompt' ? 'running' : phase };
    // An empty line ends no command: the prompt simply comes back.
    case 'done': return phase === 'running' ? { phase: 'idle', exit: mark.exit } : { phase };
    default: return { phase };
  }
}

/**
 * What output too old for the buffer said, for a snapshot it may be newer
 * than. The phase it leads to depends on the phase it started from, so it is
 * followed from each: the seed picks the snapshot's.
 */
interface Overflow {
  scanner: OscScanner;
  /** The sequence of the event being read. */
  reading: number | undefined;
  /** The first event that left the buffer: `null` when it had no sequence. */
  first: number | null | undefined;
  newest: number | undefined;
  unsequenced: boolean;
  /**
   * How the output that left the buffer starts, as the rest of a sequence the
   * snapshot may leave open, which the overflow's own parser read as text: the
   * characters `OscScanner` counts in a sequence, up to the first that ends
   * it, or until they run past `MAX_OSC`.
   */
  lead: string;
  /** `lead` holds that end, or ran past `MAX_OSC`: the output after it is not in it. */
  leadEnded: boolean;
  phases: Record<Phase, { phase: Phase; exit?: { sequence: number | undefined; code: number | null } }>;
  cwd?: { sequence: number | undefined; path: string };
}

/** What ends a sequence in progress (`OscScanner`): BEL, ESC, C1 ST, CAN and SUB. */
const OSC_END = /[\x07\x1b\x9c\x18\x1a]/;
/** The other C0 controls, which a sequence drops without counting them. */
const OSC_DROPPED = /[\x00-\x1f]/g;

export interface ShellStatus {
  running(running: boolean): void;
  exit(code: number | null): void;
  cwd(path: string): void;
}

export class ShellStatusReader {
  #scanner = this.#newScanner();
  /** False until the status was read from a snapshot, or again after the socket dropped: output waits in `#early`. */
  #seeded = false;
  #early: { data: string; sequence: number | undefined }[] = [];
  #earlyChars = 0;
  #overflow: Overflow | null = null;
  /** After the seed, the last output sequence read: an older one is in the snapshot. */
  #seen: number | undefined;
  #phase: Phase = 'idle';

  constructor(private readonly status: ShellStatus) {}

  get seeded(): boolean {
    return this.#seeded;
  }

  /** Output was lost with the socket: the next snapshot seeds the status, on a parser of its own. */
  unseed(): void {
    this.#seeded = false;
    this.#early = [];
    this.#earlyChars = 0;
    this.#overflow = null;
  }

  /** One output event as it arrives, unless the snapshot the seed read already held it. */
  read(data: string, sequence: number | undefined): void {
    if (!this.#seeded) {
      this.#keep(data, sequence);
      return;
    }
    if (sequence !== undefined && this.#seen !== undefined && sequence <= this.#seen) return;
    this.#scanner.feed(data);
    if (sequence !== undefined) this.#seen = sequence;
  }

  /**
   * The status from `output`, a snapshot up to `sequence`, then from the
   * output that came after it, parsed as the snapshot's continuation.
   */
  seed(output: string, sequence: number | undefined): void {
    const newer = (held: number | undefined) => held === undefined || sequence === undefined || held > sequence;
    const early = this.#early;
    const overflow = this.#overflow;
    this.unseed();
    this.#seeded = true;
    this.#phase = 'idle';
    this.status.running(false);
    this.#scanner = this.#newScanner();
    this.#scanner.feed(output);
    if (overflow !== null && (overflow.unsequenced || newer(overflow.newest)) && !this.#stitch(overflow, newer(overflow.first ?? undefined))) {
      // Output newer than the snapshot left the buffer: what it said, then the parser where it stopped.
      const followed = overflow.phases[this.#phase];
      this.#phase = followed.phase;
      this.status.running(followed.phase === 'running');
      if (followed.exit !== undefined && newer(followed.exit.sequence)) this.status.exit(followed.exit.code);
      if (overflow.cwd !== undefined && newer(overflow.cwd.sequence)) this.status.cwd(overflow.cwd.path);
      this.#scanner = overflow.scanner;
    }
    this.#seen = sequence;
    for (const event of early) this.read(event.data, event.sequence);
  }

  /**
   * Ends a sequence the snapshot leaves open with the overflow's first
   * characters, when all of the overflow follows the snapshot: the overflow's
   * parser read them as text. True when the overflow was nothing but the rest
   * of that sequence, and the snapshot's parser goes on from there.
   */
  #stitch(overflow: Overflow, follows: boolean): boolean {
    if (!follows || !this.#scanner.open) return false;
    this.#scanner.feed(overflow.lead);
    return !overflow.leadEnded;
  }

  #keep(data: string, sequence: number | undefined): void {
    this.#early.push({ data, sequence });
    this.#earlyChars += data.length;
    while (this.#earlyChars > MAX_EARLY) {
      const old = this.#early.shift()!;
      this.#earlyChars -= old.data.length;
      this.#summarize(old.data, old.sequence);
    }
  }

  #summarize(data: string, sequence: number | undefined): void {
    const overflow = this.#overflow ??= {
      scanner: this.#newScanner(),
      reading: undefined,
      first: sequence ?? null,
      newest: undefined,
      unsequenced: false,
      lead: '',
      leadEnded: false,
      phases: { idle: { phase: 'idle' }, prompt: { phase: 'prompt' }, running: { phase: 'running' } }
    };
    overflow.reading = sequence;
    if (sequence === undefined) overflow.unsequenced = true;
    else overflow.newest = Math.max(overflow.newest ?? sequence, sequence);
    if (!overflow.leadEnded) {
      const end = data.search(OSC_END);
      overflow.lead += (end >= 0 ? data.slice(0, end) : data).replace(OSC_DROPPED, '').slice(0, MAX_OSC + 1 - overflow.lead.length);
      if (end >= 0 && overflow.lead.length <= MAX_OSC) overflow.lead += data[end];
      overflow.leadEnded = end >= 0 || overflow.lead.length > MAX_OSC;
    }
    overflow.scanner.feed(data);
  }

  #newScanner(): OscScanner {
    return new OscScanner((code, data) => {
      if (this.#seeded) this.#report(code, data);
      else this.#overflowed(code, data);
    });
  }

  /** One OSC of output that left the buffer: kept as what it changes. */
  #overflowed(code: number, data: string): void {
    const overflow = this.#overflow;
    if (overflow === null) return;
    const sequence = overflow.reading;
    if (code !== 133) {
      const path = reportedCwd(code, data);
      if (path !== null) overflow.cwd = { sequence, path };
      return;
    }
    const mark = parsePromptMark(data);
    if (mark === null) return;
    for (const start of PHASES) {
      const followed = overflow.phases[start];
      const step = after(followed.phase, mark);
      followed.phase = step.phase;
      if (step.exit !== undefined) followed.exit = { sequence, code: step.exit };
    }
  }

  /** One OSC of the shell's output: its command status and its directory. */
  #report(code: number, data: string): void {
    if (code !== 133) {
      const path = reportedCwd(code, data);
      if (path !== null) this.status.cwd(path);
      return;
    }
    const mark = parsePromptMark(data);
    if (mark === null) return;
    const step = after(this.#phase, mark);
    this.#phase = step.phase;
    this.status.running(step.phase === 'running');
    if (step.exit !== undefined) this.status.exit(step.exit);
  }
}
