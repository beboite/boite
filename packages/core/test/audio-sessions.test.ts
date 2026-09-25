/**
 * The audio mute against a real audio session, on this machine's real endpoint.
 *
 * Nothing here is audible: the fixture writes two seconds of zeroed PCM, which
 * is a session in the Windows mixer and silence in the speakers. The test only
 * ever reads the mute state of sessions it did not open, and the one session it
 * watches being muted is the fixture's own.
 */
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { coInitialize, coUninitialize, openSessions } from '../src/platform/windows/audio-sessions.ts';
import type { AudioSession, AudioSessions } from '../src/platform/windows/audio-sessions.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const onWindows = process.platform === 'win32';
let hasAudioEndpoint = false;
if (onWindows) {
  coInitialize();
  const probe = openSessions();
  hasAudioEndpoint = probe !== null;
  probe?.release();
  coUninitialize();
  if (!hasAudioEndpoint) console.info('Audio integration tests skipped: no default render endpoint on this host');
}
const describeWindows = hasAudioEndpoint ? describe : describe.skip;
const FIXTURE = join(import.meta.dir, 'fixtures', 'silent-tone.ts');
/**
 * How long the core has to mute a session that exists. Starting a Bun process
 * and opening a wave device is a second or so on its own and has nothing to do
 * with the mute, so the clock starts when the session is in the mixer.
 */
const MUTE_WINDOW_MS = 3000;
/**
 * How long a session the core muted takes to show in its mutedPids: one poll of
 * the guard Worker (a second) and the message to the main thread, with margin.
 */
const INHERITED_WINDOW_MS = 2000;
const SESSION_WINDOW_MS = 15000;

describeWindows('the audio sessions of the default endpoint', () => {
  let endpoint: AudioSessions | null = null;

  /** Every session of one pid, with every other handle of the walk released. */
  function sessionsOf(pid: number): AudioSession[] {
    const mine: AudioSession[] = [];
    for (const session of endpoint?.list() ?? []) {
      if (session.pid === pid) mine.push(session);
      else session.release();
    }
    return mine;
  }

  function hasSession(pid: number): boolean {
    const mine = sessionsOf(pid);
    for (const session of mine) session.release();
    return mine.length > 0;
  }

  beforeAll(() => {
    coInitialize();
    endpoint = openSessions();
  });

  afterAll(() => {
    endpoint?.release();
    endpoint = null;
    coUninitialize();
  });

  test('the default render endpoint answers with a session list and nothing is touched', () => {
    expect(endpoint).not.toBeNull();
    const sessions = endpoint?.list() ?? [];
    try {
      for (const session of sessions) {
        expect(typeof session.pid).toBe('number');
        expect(Number.isInteger(session.pid)).toBe(true);
        expect(session.pid).toBeGreaterThan(0);
        // Reading a mute state changes nothing: this is what the test asserts on
        // other people's sessions, and it must stay a read.
        expect([true, false, null]).toContain(session.getMute());
      }
    } finally {
      for (const session of sessions) session.release();
    }
  });

  describe('a process a thread launched', () => {
    let harness: TestCore;

    beforeEach(async () => {
      harness = await startTestCore();
    });

    afterEach(async () => {
      await harness.stop();
    });

    test('has its audio session muted while it runs and unmuted when it exits', async () => {
      expect(endpoint).not.toBeNull();
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client);

      // The echo driver wraps the command in `cmd /c`, and that shell carries
      // the fixture's name in its own command line: the process with the audio
      // session is the Bun grandchild the Job Object reported, not the shell.
      const started = client.next(
        'process.started',
        (record) =>
          record.threadId === threadId &&
          record.commandLine?.includes('silent-tone') === true &&
          record.commandLine.startsWith('bun'),
        20000,
      );
      const muted = client.next('process.muted', (event) => event.threadId === threadId, 20000);
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 40000);

      await client.call('turns.start', { threadId, prompt: `[spawn:bun ${FIXTURE}]` });
      const fixture = await started;
      expect(fixture.pid).toBeGreaterThan(0);

      await waitFor(() => hasSession(fixture.pid), SESSION_WINDOW_MS);
      const coreMuted = (): boolean => harness.core.procs.guardStatus().mutedPids.includes(fixture.pid);
      // Windows keeps a mute per executable, so the fixture's bun.exe can open
      // its session already muted by an earlier run, here or in another checkout.
      // The core leaves a session that reads muted alone, as the user's choice,
      // and never reports it. Its own mute is reported within one poll, so only a
      // session the core has not claimed after that window is given its sound
      // back, for the core to take on its next poll.
      const claimed = await waitFor(coreMuted, INHERITED_WINDOW_MS).then(
        () => true,
        () => false,
      );
      let unmuted = false;
      if (!claimed) {
        const inherited = sessionsOf(fixture.pid);
        try {
          for (const session of inherited) {
            if (session.getMute() === true && session.mute(false)) unmuted = true;
          }
        } finally {
          for (const session of inherited) session.release();
        }
      }
      await waitFor(coreMuted, MUTE_WINDOW_MS);
      if (unmuted) {
        // The core's report can still land just after the window on a loaded
        // machine. Then the mute this test lifted was the core's own, which it
        // holds and never takes twice: put it back rather than read our own
        // unmute as the core's failure. An inherited mute is taken again by the
        // core itself, and the mixer already reads muted.
        const retaken = sessionsOf(fixture.pid);
        try {
          for (const session of retaken) if (session.getMute() === false) session.mute(true);
        } finally {
          for (const session of retaken) session.release();
        }
      }
      const status = harness.core.procs.guardStatus();
      expect(status.audio).toBe('on');
      expect(status.mutedPids).toContain(fixture.pid);
      expect((await muted).pid).toBe(fixture.pid);

      // The mixer itself, read from this process: the fixture's session is muted.
      const live = sessionsOf(fixture.pid);
      try {
        expect(live.length).toBeGreaterThan(0);
        for (const session of live) expect(session.getMute()).toBe(true);
      } finally {
        for (const session of live) session.release();
      }

      await finished;
      await waitFor(() => !harness.core.procs.guardStatus().mutedPids.includes(fixture.pid), 5000);

      // Windows keeps a rendering session's mute across runs, so what is left of
      // that pid in the mixer must not be muted any more.
      const after = sessionsOf(fixture.pid);
      try {
        for (const session of after) expect(session.getMute()).not.toBe(true);
      } finally {
        for (const session of after) session.release();
      }
    }, 60000);
  });
});
