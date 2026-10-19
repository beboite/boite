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
import { CFunction, FFIType, ptr } from 'bun:ffi';
import { coInitialize, coUninitialize, openSessions, vtables } from '../src/platform/windows/audio-sessions.ts';
import type { AudioSession, AudioSessions } from '../src/platform/windows/audio-sessions.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import { hostMutes } from './host-mutes.ts';
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

/** Whether the Boite running these tests mutes the fixture's session itself (`host-mutes.ts`). */
async function hostMutesAgents(): Promise<boolean> {
  coInitialize();
  const probe = openSessions();
  const child = Bun.spawn(['bun', FIXTURE], { stdout: 'ignore', stderr: 'ignore' });
  /** Every session of the fixture, each released once seen. */
  const each = (see: (session: AudioSession) => void): boolean => {
    let found = false;
    for (const session of probe?.list() ?? []) {
      if (session.pid === child.pid) {
        found = true;
        see(session);
      }
      session.release();
    }
    return found;
  };
  try {
    return await hostMutes({
      read: () => {
        let muted: boolean | null = null;
        return each((session) => { if (muted !== true) muted = session.getMute(); }) ? muted : null;
      },
      unmute: () => {
        let took = true;
        each((session) => { took = session.mute(false) && took; });
        return took;
      }
    }, { appearMs: 10_000, muteMs: MUTE_WINDOW_MS, remuteMs: 1500 });
  } finally {
    child.kill();
    await child.exited;
    probe?.release();
    coUninitialize();
  }
}

const hostMutesFixture = hasAudioEndpoint && await hostMutesAgents();
if (hostMutesFixture) console.info('Thread audio tests skipped: the Boite running these tests mutes what its agents start (muteAgents), so the test core never gets to mute the fixture');
const describeWindows = hasAudioEndpoint ? describe : describe.skip;

/** `waitFor` that answers whether the condition came true instead of throwing. */
async function settles(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  try {
    await waitFor(predicate, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

(onWindows ? describe : describe.skip)('the objects Core Audio calls back', () => {
  /** Calls a vtable slot the way Core Audio does, with `this` and up to two more pointers. */
  function call(address: bigint, ...args: (Uint8Array | BigUint64Array | null)[]): number {
    const native = CFunction({ ptr: Number(address) as never, args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
    return native(...[...args, null, null, null].slice(0, 3).map((arg) => (arg === null ? null : ptr(arg))));
  }

  test('answer QueryInterface with E_NOINTERFACE and a null interface, count one reference, and take a property change', () => {
    const { session, client } = vtables();
    const self = new BigUint64Array(1);
    const iid = new Uint8Array(16);
    for (const table of [session, client]) {
      const out = new BigUint64Array([0xdeadbeefn]);
      expect(call(table[0]!, self, iid, out) >>> 0).toBe(0x80004002);
      expect(out[0]).toBe(0n);
      // A caller that passes no out parameter gets the same answer, not a crash.
      expect(call(table[0]!, self, iid, null) >>> 0).toBe(0x80004002);
      expect(call(table[1]!, self)).toBe(1);
      expect(call(table[2]!, self)).toBe(1);
    }
    // OnPropertyValueChanged: S_OK, nothing to walk for.
    expect(call(client[7]!, self, null, null)).toBe(0);
  });
});

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

  /**
   * Windows keeps a session's mute per executable across runs, so a run that
   * was cut short before the core unmuted the fixture leaves every later Bun
   * session muted from its first sample. The core rightly takes a session that
   * is muted already for the user's own choice and never touches it, and the
   * test would then wait for a mute that cannot come. The fixture's own session
   * is the only one this changes, and only while the core does not hold it.
   */
  function clearLeftoverMute(pid: number): void {
    for (const session of sessionsOf(pid)) {
      if (session.getMute() === true) {
        console.info(`audio test: pid ${pid} started muted, a mute an earlier run left behind; unmuting it`);
        session.mute(false);
      }
      session.release();
    }
  }

  /** A turn that plays the fixture, once the core has muted its session; `delayMs` opens the device that much later. */
  async function mutedFixture(harness: TestCore, delayMs = 0): Promise<{ threadId: string; pid: number; finished: Promise<unknown> }> {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

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
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 40000);

    await client.call('turns.start', { threadId, prompt: `[spawn:bun ${FIXTURE}${delayMs > 0 ? ` ${delayMs}` : ''}]` });
    const fixture = await started;
    expect(fixture.pid).toBeGreaterThan(0);

    await waitFor(() => hasSession(fixture.pid), SESSION_WINDOW_MS);
    const mutedByCore = (): boolean => harness.core.procs.guardStatus().mutedPids.includes(fixture.pid);
    // Only once the core had its whole window and did not take the session:
    // earlier, a session reading muted is the core's own mute on its way here.
    if (!(await settles(mutedByCore, MUTE_WINDOW_MS))) {
      clearLeftoverMute(fixture.pid);
      await waitFor(mutedByCore, MUTE_WINDOW_MS);
      // The core's report can still land just after the window on a loaded
      // machine. Then the mute this lifted was the core's own, which it holds
      // and never takes twice: put it back rather than read our own unmute as
      // the core's failure. An inherited mute is taken again by the core
      // itself, and the mixer already reads muted.
      const retaken = sessionsOf(fixture.pid);
      try {
        for (const session of retaken) if (session.getMute() === false) session.mute(true);
      } finally {
        for (const session of retaken) session.release();
      }
    }
    return { threadId, pid: fixture.pid, finished };
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
    // Nobody switched output device during the test: the id read back matches.
    expect(endpoint?.stale()).toBe(false);
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

  test('a session another process opens is reported by the endpoint itself', async () => {
    const watched = openSessions();
    expect(watched).not.toBeNull();
    let notices = 0;
    const child = Bun.spawn(['bun', FIXTURE, '1000'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      // Core Audio only reports to a manager that enumerated its sessions once.
      for (const session of watched!.list()) session.release();
      watched!.watch!(() => { notices += 1; });
      await waitFor(() => hasSession(child.pid), SESSION_WINDOW_MS);
      await waitFor(() => notices > 0, MUTE_WINDOW_MS);
    } finally {
      child.kill();
      await child.exited;
      watched?.release();
    }
  }, 30000);

  (hostMutesFixture ? describe.skip : describe)('a process a thread launched', () => {
    let harness: TestCore;

    beforeEach(async () => {
      harness = await startTestCore();
    });

    afterEach(async () => {
      await harness.stop();
    });

    test('has its audio session muted while it runs and unmuted when it exits', async () => {
      expect(endpoint).not.toBeNull();
      const mutes: number[] = [];
      harness.core.bus.onAny((name, payload) => {
        if (name === 'process.muted') mutes.push((payload as { pid: number }).pid);
      });
      const { pid, finished } = await mutedFixture(harness);
      const fixture = { pid };
      const status = harness.core.procs.guardStatus();
      expect(status.audio).toBe('on');
      expect(status.mutedPids).toContain(fixture.pid);
      expect(mutes).toContain(fixture.pid);

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

    test('that starts its audio late is muted on the endpoint\'s notice, long before the half-minute walk', async () => {
      // The pid is traced and walked for at once, with no session yet; the
      // session opens seconds later, and only Core Audio's notice walks again
      // inside the window `mutedFixture` allows.
      const { pid, finished } = await mutedFixture(harness, 4000);
      expect(harness.core.procs.guardStatus().mutedPids).toContain(pid);
      await finished;
      await waitFor(() => !harness.core.procs.guardStatus().mutedPids.includes(pid), 5000);
    }, 60000);

    test('is unmuted by the time the core has closed, even when it was still playing', async () => {
      const { pid } = await mutedFixture(harness);
      // This process's own references: a session object answers while one is
      // held, even once the process that opened it is gone.
      const held = sessionsOf(pid);
      try {
        expect(held.length).toBeGreaterThan(0);
        for (const session of held) expect(session.getMute()).toBe(true);

        // Closing kills the fixture while its session is muted. The Worker's
        // own release is then the only unmute left, and a core that exits right
        // after `close` resolves must not beat it: Windows would keep the mute
        // for the next run of that executable.
        await harness.stop();
        for (const session of held) expect(session.getMute()).toBe(false);
      } finally {
        for (const session of held) session.release();
      }
    }, 60000);
  });
});
