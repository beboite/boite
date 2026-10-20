/**
 * The probe that tells whether the Boite running the audio tests mutes what its
 * agents start, against a fake mixer and clock: a probe that answers yes
 * without seeing a re-mute skips the native tests when they matter most.
 */
import { describe, expect, test } from 'bun:test';
import { hostMutes, type FixtureSession, type ProbeClock } from './host-mutes.ts';

const WINDOWS = { appearMs: 10_000, muteMs: 3000, remuteMs: 1500 };

interface Mixer {
  /** When the fixture's session shows in the mixer. */
  appearsAt: number;
  /** It was muted by an earlier run before it appeared. */
  inherited?: boolean;
  /** The host mutes a session that appears unmuted this long after; none when absent. */
  hostAfter?: number;
  /** And again this long after an unmute, 100 ms by default: it hears of it through Core Audio. */
  remuteAfter?: number;
  /** SetMute answers this and, when false, changes nothing. */
  setMuteWorks?: boolean;
  /** SetMute says it took the unmute and changes nothing. */
  setMuteIgnored?: boolean;
}

/** A fixture session and a clock that only moves when the probe sleeps. */
function fake(mixer: Mixer): { session: FixtureSession; clock: ProbeClock } {
  let now = 0;
  let muted = mixer.inherited === true;
  let hostAt: number | null = mixer.hostAfter === undefined || muted ? null : mixer.appearsAt + mixer.hostAfter;
  const tick = () => {
    if (hostAt !== null && now >= hostAt) {
      muted = true;
      hostAt = null;
    }
  };
  return {
    session: {
      read: () => {
        tick();
        return now < mixer.appearsAt ? null : muted;
      },
      unmute: () => {
        tick();
        if (mixer.setMuteWorks === false) return false;
        if (mixer.setMuteIgnored === true) return true;
        muted = false;
        if (mixer.hostAfter !== undefined) hostAt = now + (mixer.remuteAfter ?? 100);
        return true;
      }
    },
    clock: { now: () => now, sleep: async (ms) => { now += ms; } }
  };
}

describe('whether the host mutes the fixture', () => {
  test('a host that mutes it on sight and again after an unmute does', async () => {
    const { session, clock } = fake({ appearsAt: 800, hostAfter: 0 });
    expect(await hostMutes(session, WINDOWS, clock)).toBe(true);
  });

  test('a host that mutes it a little after it appears does', async () => {
    const { session, clock } = fake({ appearsAt: 800, hostAfter: 100 });
    expect(await hostMutes(session, WINDOWS, clock)).toBe(true);
  });

  test('a mute an earlier run left behind is no host', async () => {
    const { session, clock } = fake({ appearsAt: 800, inherited: true });
    expect(await hostMutes(session, WINDOWS, clock)).toBe(false);
  });

  test('a left-behind mute that SetMute cannot undo is no host either', async () => {
    const { session, clock } = fake({ appearsAt: 800, inherited: true, setMuteWorks: false });
    expect(await hostMutes(session, WINDOWS, clock)).toBe(false);
  });

  test('a session that never shows or is never muted is no host', async () => {
    for (const mixer of [{ appearsAt: 20_000, hostAfter: 0 }, { appearsAt: 800 }]) {
      const { session, clock } = fake(mixer);
      expect(await hostMutes(session, WINDOWS, clock)).toBe(false);
    }
  });

  test('an unmute SetMute says it took while the session stays muted is no host', async () => {
    const { session, clock } = fake({ appearsAt: 800, inherited: true, setMuteIgnored: true });
    expect(await hostMutes(session, WINDOWS, clock)).toBe(false);
  });
});
