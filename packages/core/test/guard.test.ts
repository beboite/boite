import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AudioSession } from '../src/platform/windows/audio-sessions.ts';
import { GuardLogic, HWND_BOTTOM, PUSH_BACK_FLAGS } from '../src/platform/windows/guard-logic.ts';
import type { GuardWin32, WindowOwner } from '../src/platform/windows/guard-logic.ts';
import { MuteLogic } from '../src/platform/windows/mute-logic.ts';
import { setGuardIdleGrace } from '../src/platform/windows/guard.ts';
import { jobsWorkerRunning, setJobsIdleGrace } from '../src/platform/windows/jobs.ts';
import type { ThreadId } from '@boite/contracts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const OWN_THREAD = 100;
/** The window the user is on: another process, another thread. */
const USER_HWND = 0x1000n;
const USER_THREAD = 200;
const USER_PID = 4242;
/** A window of a process a Boite thread launched. */
const AGENT_HWND = 0x2000n;
const AGENT_THREAD = 300;
const AGENT_PID = 5150;

type Call =
  | { call: 'setWindowPos'; hwnd: bigint; insertAfter: bigint; flags: number }
  | { call: 'attachThreadInput'; from: number; to: number; attach: boolean }
  | { call: 'setForegroundWindow'; hwnd: bigint }
  | { call: 'windowTitle'; hwnd: bigint };

interface FakeOptions {
  /** What `GetForegroundWindow` answers when the guard starts. */
  foreground?: bigint;
  /** What `SetForegroundWindow` answers. */
  restores?: boolean;
}

class FakeWin32 implements GuardWin32 {
  readonly calls: Call[] = [];
  readonly windows = new Map<bigint, WindowOwner>([
    [USER_HWND, { pid: USER_PID, threadId: USER_THREAD }],
    [AGENT_HWND, { pid: AGENT_PID, threadId: AGENT_THREAD }],
  ]);

  constructor(private readonly options: FakeOptions = {}) {}

  windowPid(hwnd: bigint): WindowOwner | null {
    return this.windows.get(hwnd) ?? null;
  }

  windowTitle(hwnd: bigint): string {
    this.calls.push({ call: 'windowTitle', hwnd });
    return hwnd === AGENT_HWND ? 'Agent installer' : 'The user was here';
  }

  setWindowPos(hwnd: bigint, insertAfter: bigint, flags: number): boolean {
    this.calls.push({ call: 'setWindowPos', hwnd, insertAfter, flags });
    return true;
  }

  attachThreadInput(from: number, to: number, attach: boolean): boolean {
    this.calls.push({ call: 'attachThreadInput', from, to, attach });
    return true;
  }

  setForegroundWindow(hwnd: bigint): boolean {
    this.calls.push({ call: 'setForegroundWindow', hwnd });
    return this.options.restores ?? true;
  }

  foregroundWindow(): bigint {
    return this.options.foreground ?? 0n;
  }

  ownThreadId(): number {
    return OWN_THREAD;
  }

  /** Everything but the title read, which is only there to fill the event. */
  acted(): Call[] {
    return this.calls.filter((entry) => entry.call !== 'windowTitle');
  }
}

/** A guard that already knows the window the user was on and the agent's pid. */
function armed(options: FakeOptions = {}): { win32: FakeWin32; logic: GuardLogic } {
  const win32 = new FakeWin32({ foreground: USER_HWND, ...options });
  const logic = new GuardLogic(win32, true);
  logic.addPid('thr_one', AGENT_PID);
  win32.calls.length = 0;
  return { win32, logic };
}

describe('the focus guard rule', () => {
  test('an agent window is pushed to the bottom and the user gets the focus back', () => {
    const { win32, logic } = armed();

    logic.onForeground(AGENT_HWND);

    expect(win32.acted()).toEqual([
      { call: 'setWindowPos', hwnd: AGENT_HWND, insertAfter: HWND_BOTTOM, flags: PUSH_BACK_FLAGS },
      { call: 'attachThreadInput', from: OWN_THREAD, to: USER_THREAD, attach: true },
      { call: 'setForegroundWindow', hwnd: USER_HWND },
      { call: 'attachThreadInput', from: OWN_THREAD, to: USER_THREAD, attach: false },
    ]);
    expect(logic.events).toEqual([
      {
        kind: 'foreground-pushed',
        threadId: 'thr_one',
        pid: AGENT_PID,
        hwnd: AGENT_HWND.toString(),
        title: 'Agent installer',
        restored: true,
      },
    ]);
  });

  test('the push-back flags never move, size or activate the window', () => {
    const { win32, logic } = armed();
    logic.onForeground(AGENT_HWND);
    const pushed = win32.acted()[0];
    expect(pushed).toMatchObject({ call: 'setWindowPos', insertAfter: 1n });
    // SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
    expect(PUSH_BACK_FLAGS).toBe(0x0013);
  });

  test('with no previous window known it still pushes back, and says it restored nothing', () => {
    const win32 = new FakeWin32();
    const logic = new GuardLogic(win32, true);
    logic.addPid('thr_one', AGENT_PID);

    logic.onForeground(AGENT_HWND);

    expect(win32.acted()).toEqual([
      { call: 'setWindowPos', hwnd: AGENT_HWND, insertAfter: HWND_BOTTOM, flags: PUSH_BACK_FLAGS },
    ]);
    expect(logic.events[0]?.restored).toBe(false);
  });

  test('a window nobody traced is only remembered as the place to go back to', () => {
    const win32 = new FakeWin32();
    const logic = new GuardLogic(win32, true);
    logic.addPid('thr_one', AGENT_PID);

    logic.onForeground(USER_HWND);
    expect(win32.acted()).toEqual([]);
    expect(logic.events).toEqual([]);

    logic.onForeground(AGENT_HWND);
    expect(win32.acted()).toContainEqual({ call: 'setForegroundWindow', hwnd: USER_HWND });
    expect(logic.events[0]?.restored).toBe(true);
  });

  test('the guard turned off does nothing at all', () => {
    const { win32, logic } = armed();
    logic.setEnabled(false);

    logic.onForeground(AGENT_HWND);

    expect(win32.calls).toEqual([]);
    expect(logic.events).toEqual([]);

    logic.setEnabled(true);
    logic.onForeground(AGENT_HWND);
    expect(logic.events).toHaveLength(1);
  });

  test('the event the restore itself raises is ignored', () => {
    const { win32, logic } = armed();
    logic.onForeground(AGENT_HWND);
    const afterPush = win32.calls.length;

    // The system reports the user's window as the new foreground, which is our
    // own work coming back at us.
    logic.onForeground(USER_HWND);

    expect(win32.calls).toHaveLength(afterPush);
    expect(logic.events).toHaveLength(1);
  });

  test('a pid that exited is no longer guarded', () => {
    const { win32, logic } = armed();
    logic.removePid(AGENT_PID);

    logic.onForeground(AGENT_HWND);

    expect(win32.acted()).toEqual([]);
    expect(logic.events).toEqual([]);
  });

  test('a refused SetForegroundWindow is reported as restored: false', () => {
    const { win32, logic } = armed({ restores: false });

    logic.onForeground(AGENT_HWND);

    expect(win32.acted()).toContainEqual({ call: 'setForegroundWindow', hwnd: USER_HWND });
    expect(logic.events[0]?.restored).toBe(false);
  });

  test('takeEvents hands the batch over and empties it', () => {
    const { logic } = armed();
    logic.onForeground(AGENT_HWND);
    expect(logic.takeEvents()).toHaveLength(1);
    expect(logic.events).toEqual([]);
  });
});

// -- the audio mute rule, without a sound ----------------------------------

/** One session of one process, with the mute state the fake mixer holds. */
class FakeSession implements AudioSession {
  released = false;
  constructor(
    readonly pid: number,
    private readonly mixer: { muted: boolean; gone?: boolean },
  ) {}

  mute(on: boolean): boolean {
    if (this.mixer.gone === true) return false;
    this.mixer.muted = on;
    return true;
  }

  getMute(): boolean | null {
    if (this.mixer.gone === true) return null;
    return this.mixer.muted;
  }

  release(): void {
    this.released = true;
  }
}

/**
 * A fake endpoint: one mixer entry per pid, and a fresh handle on every walk,
 * the way `IAudioSessionEnumerator` hands out a new reference each time.
 */
class FakeEndpoint {
  readonly mixers = new Map<number, { muted: boolean; gone?: boolean }>();
  readonly handed: FakeSession[] = [];
  throws: string | null = null;

  add(pid: number): { muted: boolean; gone?: boolean } {
    const mixer = { muted: false };
    this.mixers.set(pid, mixer);
    return mixer;
  }

  list = (): AudioSession[] => {
    if (this.throws !== null) throw new Error(this.throws);
    const sessions: FakeSession[] = [];
    for (const [pid, mixer] of this.mixers) sessions.push(new FakeSession(pid, mixer));
    this.handed.push(...sessions);
    return sessions;
  };

  /** Every handle the walk gave out and nobody is holding any more. */
  releasedCount(): number {
    return this.handed.filter((session) => session.released).length;
  }
}

const MUTED_PID = 7001;
const OTHER_PID = 7002;

describe('the audio mute rule', () => {
  test('an idle mute never enumerates the endpoint', () => {
    let walks = 0;
    const mute = new MuteLogic(() => { walks += 1; return []; }, true);
    mute.tick();
    expect(walks).toBe(0);
    mute.addPid('thr_one', MUTED_PID);
    expect(walks).toBe(1);
    mute.removePid(MUTED_PID);
    mute.tick();
    expect(walks).toBe(1);
  });
  test('a session of a traced pid is muted once and reported once', () => {
    const endpoint = new FakeEndpoint();
    const mixer = endpoint.add(MUTED_PID);
    const mute = new MuteLogic(endpoint.list, true);

    mute.addPid('thr_one', MUTED_PID);
    expect(mixer.muted).toBe(true);
    expect(mute.takeEvents()).toEqual([{ kind: 'session-muted', threadId: 'thr_one', pid: MUTED_PID }]);
    expect(mute.mutedPids()).toEqual([MUTED_PID]);

    // A second walk sees the same session, already muted, and keeps quiet.
    mute.tick();
    mute.tick();
    expect(mute.takeEvents()).toEqual([]);
    expect(mixer.muted).toBe(true);
  });

  test('a session nobody traced is left alone and its handle released', () => {
    const endpoint = new FakeEndpoint();
    const mixer = endpoint.add(OTHER_PID);
    const mute = new MuteLogic(endpoint.list, true);

    mute.addPid('thr_without_audio', MUTED_PID);

    expect(mixer.muted).toBe(false);
    expect(mute.events).toEqual([]);
    expect(mute.mutedPids()).toEqual([]);
    expect(endpoint.releasedCount()).toBe(1);
  });

  test('a pid that exits is unmuted and its session released', () => {
    const endpoint = new FakeEndpoint();
    const mixer = endpoint.add(MUTED_PID);
    const mute = new MuteLogic(endpoint.list, true);
    mute.addPid('thr_one', MUTED_PID);
    expect(mixer.muted).toBe(true);

    mute.removePid(MUTED_PID);

    expect(mixer.muted).toBe(false);
    expect(mute.mutedPids()).toEqual([]);
    expect(endpoint.handed.every((session) => session.released)).toBe(true);
  });

  test('turning the mute off gives every held session its sound back', () => {
    const endpoint = new FakeEndpoint();
    const one = endpoint.add(MUTED_PID);
    const two = endpoint.add(OTHER_PID);
    const mute = new MuteLogic(endpoint.list, true);
    mute.addPid('thr_one', MUTED_PID);
    mute.addPid('thr_two', OTHER_PID);
    expect([one.muted, two.muted]).toEqual([true, true]);

    mute.setEnabled(false);

    expect([one.muted, two.muted]).toEqual([false, false]);
    expect(mute.mutedPids()).toEqual([]);
    // And a walk while it is off does nothing at all.
    mute.tick();
    expect([one.muted, two.muted]).toEqual([false, false]);
  });

  test('a listing that keeps failing is reported once per distinct message', () => {
    const endpoint = new FakeEndpoint();
    endpoint.add(MUTED_PID);
    const mute = new MuteLogic(endpoint.list, true);

    endpoint.throws = 'IAudioSessionManager2::GetSessionEnumerator failed with 0x88890004';
    mute.addPid('thr_one', MUTED_PID);
    mute.tick();
    mute.tick();
    mute.tick();
    expect(mute.events).toEqual([
      { kind: 'audio-failed', message: 'IAudioSessionManager2::GetSessionEnumerator failed with 0x88890004' },
    ]);

    endpoint.throws = 'CoCreateInstance(MMDeviceEnumerator) failed with 0x80040154';
    mute.tick();
    mute.tick();
    expect(mute.takeEvents()).toHaveLength(2);
  });

  test('a session that vanished before the pid exits is released without a throw', () => {
    const endpoint = new FakeEndpoint();
    const mixer = endpoint.add(MUTED_PID);
    const mute = new MuteLogic(endpoint.list, true);
    mute.addPid('thr_one', MUTED_PID);
    mute.takeEvents();

    // The process died: the mixer entry answers nothing any more.
    mixer.gone = true;
    mute.removePid(MUTED_PID);

    expect(mute.mutedPids()).toEqual([]);
    expect(endpoint.handed.every((session) => session.released)).toBe(true);
    expect(mute.events).toEqual([]);
  });
});

// -- the real Worker, without ever creating a window ------------------------

const onWindows = process.platform === 'win32';
const describeWindows = onWindows ? describe : describe.skip;

describeWindows('the focus guard Worker', () => {
  let harness: TestCore;
  let stopped = false;

  beforeEach(async () => {
    harness = await startTestCore();
    stopped = false;
  });

  afterEach(async () => {
    if (!stopped) await harness.stop();
  });

  test('comes up on the first traced pid with a real hook, and goes with the core', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);

    expect(harness.core.procs.guardStatus().running).toBe(false);
    await client.call('turns.start', { threadId, prompt: '[spawn:ping -n 2 127.0.0.1]' });

    await waitFor(() => harness.core.procs.guardStatus().hook !== null, 10000);
    const status = harness.core.procs.guardStatus();
    expect(status.running).toBe(true);
    expect(status.failure).toBeNull();
    // The handle SetWinEventHook returned: zero would mean no hook is installed.
    expect(status.hook).not.toBe('0');
    expect(BigInt(status.hook ?? '0') > 0n).toBe(true);

    await finished;
    await harness.stop();
    stopped = true;
    expect(harness.core.procs.guardStatus().running).toBe(false);
  }, 30000);

  test('both Workers go once the last traced process is gone, and come back for the next one', async () => {
    setGuardIdleGrace(200);
    setJobsIdleGrace(200);
    try {
      const procs = harness.core.procs;
      const threadId = 'idle-workers' as ThreadId;
      // The grandchild is only ever seen through the Job Object's own events.
      const script = "Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 400)'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }).exited.then(() => {})";
      const run = async (): Promise<{ most: number; guarded: boolean; drained: boolean }> => {
        const seen = { most: 0, guarded: false, drained: false };
        const watch = setInterval(() => {
          seen.most = Math.max(seen.most, procs.liveCount(threadId));
          seen.guarded ||= procs.guardStatus().running;
          seen.drained ||= jobsWorkerRunning();
        }, 5);
        const child = procs.spawnPiped(threadId, process.execPath, ['-e', script]);
        child.proc.stdin.end();
        await child.exited;
        await waitFor(() => procs.liveCount(threadId) === 0, 10000);
        clearInterval(watch);
        return seen;
      };

      expect(await run()).toEqual({ most: 2, guarded: true, drained: true });
      await waitFor(() => !procs.guardStatus().running && !jobsWorkerRunning(), 5000);
      expect(await run()).toEqual({ most: 2, guarded: true, drained: true });
      await waitFor(() => !procs.guardStatus().running && !jobsWorkerRunning(), 5000);
    } finally {
      setGuardIdleGrace(30_000);
      setJobsIdleGrace(30_000);
    }
  }, 30000);
});
