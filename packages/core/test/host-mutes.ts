/**
 * Whether a Boite that runs the audio tests, an agent's turn on this machine,
 * mutes what its agents start (`muteAgents`). The test core then finds the
 * fixture muted already, takes that for the user's choice and never mutes it
 * itself, so the tests that need it to cannot pass there.
 */

/** The fixture's audio session, as the probe sees it. */
export interface FixtureSession {
  /** Muted, or null while the session is not in the mixer. */
  read(): boolean | null;
  /** Whether Core Audio took the unmute. */
  unmute(): boolean;
}

export interface ProbeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: ProbeClock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export interface ProbeWindows {
  /** How long the fixture takes to open its session. */
  appearMs: number;
  /** How long a host has to mute a session that exists, as the test core has. */
  muteMs: number;
  /** How long a host has to mute it again once unmuted. */
  remuteMs: number;
}

const POLL_MS = 20;

async function until(predicate: () => boolean, ms: number, clock: ProbeClock): Promise<boolean> {
  for (const end = clock.now() + ms; ; await clock.sleep(POLL_MS)) {
    if (predicate()) return true;
    if (clock.now() >= end) return false;
  }
}

/**
 * The host mutes the fixture once it is in the mixer, maybe a little after,
 * and mutes it again after an unmute that Core Audio took and that reads
 * unmuted: a mute left behind by an earlier run is not muted again, and an
 * unmute that failed proves nothing. Anything short of that is false, so the
 * tests run and say what is wrong.
 */
export async function hostMutes(session: FixtureSession, windows: ProbeWindows, clock: ProbeClock = realClock): Promise<boolean> {
  if (!await until(() => session.read() !== null, windows.appearMs, clock)) return false;
  if (!await until(() => session.read() === true, windows.muteMs, clock)) return false;
  if (!session.unmute() || session.read() !== false) return false;
  return until(() => session.read() === true, windows.remuteMs, clock);
}
