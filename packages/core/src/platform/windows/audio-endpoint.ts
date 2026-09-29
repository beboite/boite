/**
 * Which render endpoint the audio mute walks, and when to open it again. No COM
 * here: the opener is given, so `test/guard.test.ts` drives every case on fakes.
 *
 * An endpoint is reopened when its walk fails, when it is no longer the default
 * device (the user switched from speakers to a headset, which leaves the old
 * device valid and silent while the agents play on the new one), and, on a
 * machine that had no render endpoint, every half minute in case one appeared.
 */
import type { AudioSession, AudioSessions } from './audio-sessions.ts';

/** How long a machine that answered it has no render endpoint is left alone. */
export const NO_ENDPOINT_RETRY_MS = 30_000;
export const NO_ENDPOINT = 'this machine has no default audio render endpoint';

export class AudioEndpoint {
  #open: AudioSessions | null = null;
  #retryAt = 0;

  constructor(
    private readonly openSessions: () => AudioSessions | null,
    private readonly now: () => number = Date.now,
  ) {}

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
    try {
      return this.#open.list(skipped);
    } catch (error) {
      // The endpoint itself failed (one bad session does not throw): drop it so
      // the next walk opens a fresh one.
      this.release();
      throw error;
    }
  }

  release(): void {
    this.#open?.release();
    this.#open = null;
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
