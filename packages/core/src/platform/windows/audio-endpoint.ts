/**
 * Which render endpoint the audio mute walks, and when to open it again. No COM
 * here: the opener is given, so `test/guard.test.ts` drives every case on fakes.
 *
 * An endpoint is reopened when its walk fails, when it is no longer the default
 * device (the user switched from speakers to a headset, which leaves the old
 * device valid and silent while the agents play on the new one), and, on a
 * machine that had no render endpoint, every half minute in case one appeared.
 *
 * Each endpoint opened is watched once, after its first walk: Core Audio then
 * says when a session opens on it or the devices change (`changed`), and the
 * Worker walks on that instead of on a one-second clock. A refused watch is one
 * note through the walk's `skipped`, and that endpoint is polled as before.
 */
import type { AudioSession, AudioSessions } from './audio-sessions.ts';

/** How long a machine that answered it has no render endpoint is left alone. */
export const NO_ENDPOINT_RETRY_MS = 30_000;
export const NO_ENDPOINT = 'this machine has no default audio render endpoint';

export class AudioEndpoint {
  #open: AudioSessions | null = null;
  #retryAt = 0;
  /** The open endpoint reports its new sessions and device changes. */
  #watching = false;
  /** The open endpoint refused, or cannot, report them: asked again only on the next opening. */
  #unwatched = false;

  constructor(
    private readonly openSessions: () => AudioSessions | null,
    private readonly now: () => number = Date.now,
    /** What a notice of the open endpoint calls; null never watches. */
    private readonly changed: (() => void) | null = null,
  ) {}

  /** True while the open endpoint says by itself when a walk is needed. */
  get watching(): boolean {
    return this.#watching;
  }

  /** One walk of the default endpoint's sessions, opening it first when needed. */
  list(skipped: (message: string) => void): AudioSession[] {
    if (this.#open !== null && this.#stale(this.#open)) this.release();
    if (this.#open === null) {
      if (this.now() < this.#retryAt) throw new Error(NO_ENDPOINT);
      const opened = this.openSessions();
      if (opened === null) {
        this.#retryAt = this.now() + NO_ENDPOINT_RETRY_MS;
        throw new Error(NO_ENDPOINT);
      }
      this.#open = opened;
    }
    let sessions: AudioSession[];
    try {
      sessions = this.#open.list(skipped);
    } catch (error) {
      // The endpoint itself failed (one bad session does not throw): drop it so
      // the next walk opens a fresh one.
      this.release();
      throw error;
    }
    // After the walk: Core Audio only reports sessions to a manager that has
    // enumerated them once.
    if (!this.#watching && !this.#unwatched && this.changed !== null) this.#watch(this.#open, this.changed, skipped);
    return sessions;
  }

  release(): void {
    this.#open?.release();
    this.#open = null;
    this.#watching = false;
    this.#unwatched = false;
  }

  #watch(open: AudioSessions, changed: () => void, skipped: (message: string) => void): void {
    if (open.watch === undefined) {
      this.#unwatched = true;
      return;
    }
    try {
      open.watch(changed);
      this.#watching = true;
    } catch (error) {
      this.#unwatched = true;
      skipped(`audio notifications refused, polling every second: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A check that cannot answer counts as a change: reopening is always safe. */
  #stale(open: AudioSessions): boolean {
    try {
      return open.stale();
    } catch {
      return true;
    }
  }
}
