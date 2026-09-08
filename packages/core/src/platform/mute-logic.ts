/**
 * What the audio mute decides, with no COM in sight.
 *
 * The guard Worker owns the endpoint and the poll; this class owns the rule.
 * Everything native it needs is behind the `listSessions` function it is given,
 * so `test/guard.test.ts` proves every decision on a fake and nothing is ever
 * audible in a test run.
 */
import type { AudioSession } from './audio-sessions.ts';

/** One mute, or one distinct failure, on its way to the main thread. */
export type MuteEvent =
  | { kind: 'session-muted'; threadId: string; pid: number }
  | { kind: 'audio-failed'; message: string };

export class MuteLogic {
  /** pid to the thread that owns it. A session of any of these is muted. */
  readonly #pids = new Map<number, string>();
  /**
   * The volume interfaces held per pid, so the mute can be undone while the
   * session still exists. Windows keeps a rendering session's mute across
   * restarts, so a process that exits muted would come back muted.
   */
  readonly #held = new Map<number, AudioSession[]>();
  /** What was muted or failed, drained by the Worker after every pump tick. */
  readonly events: MuteEvent[] = [];
  /** One line per distinct failure: a broken endpoint must not fill the log. */
  readonly #reported = new Set<string>();

  #enabled: boolean;

  constructor(
    private readonly listSessions: () => AudioSession[],
    enabled: boolean,
  ) {
    this.#enabled = enabled;
  }

  addPid(threadId: string, pid: number): void {
    if (pid <= 0) return;
    this.#pids.set(pid, threadId);
    // A process that opens its session in its first milliseconds would otherwise
    // play until the next poll.
    this.tick();
  }

  removePid(pid: number): void {
    this.#pids.delete(pid);
    this.unhold(pid);
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    // Turning it off gives the user their sound back at once, not at the next exit.
    if (!enabled) this.releaseAll();
  }

  /** Every pid with a session this class is holding muted. */
  mutedPids(): number[] {
    return [...this.#held.keys()];
  }

  /** Everything muted or failed since the last drain. */
  takeEvents(): MuteEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /**
   * One pass over the endpoint's sessions. A session of a traced pid that is not
   * muted yet is muted and kept; one that already reads muted is either ours
   * from an earlier pass or the user's own choice, and both are left alone.
   */
  tick(): void {
    if (!this.#enabled) return;

    let sessions: AudioSession[];
    try {
      sessions = this.listSessions();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }

    for (const session of sessions) {
      const threadId = this.#pids.get(session.pid);
      if (threadId === undefined || session.getMute() !== false) {
        session.release();
        continue;
      }
      if (!session.mute(true)) {
        session.release();
        continue;
      }
      const held = this.#held.get(session.pid);
      if (held === undefined) this.#held.set(session.pid, [session]);
      else held.push(session);
      this.events.push({ kind: 'session-muted', threadId, pid: session.pid });
    }
  }

  /** Unmute and release everything held: the Worker is stopping. */
  releaseAll(): void {
    for (const pid of [...this.#held.keys()]) this.unhold(pid);
  }

  private unhold(pid: number): void {
    const held = this.#held.get(pid);
    if (held === undefined) return;
    this.#held.delete(pid);
    for (const session of held) {
      // The process may already be gone; the session object survives while this
      // reference does, which is what makes the unmute reach the mixer at all.
      session.mute(false);
      session.release();
    }
  }

  private fail(message: string): void {
    if (this.#reported.has(message)) return;
    this.#reported.add(message);
    this.events.push({ kind: 'audio-failed', message });
  }
}
