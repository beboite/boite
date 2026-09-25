import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ComError, isEndpointWide } from '../src/platform/windows/audio-sessions.ts';
import type { AudioSession } from '../src/platform/windows/audio-sessions.ts';
import { setGuardWorkerForTests } from '../src/platform/windows/guard.ts';
import { GuardLogic, HWND_BOTTOM, PUSH_BACK_FLAGS } from '../src/platform/windows/guard-logic.ts';
import type { GuardWin32, WindowOwner } from '../src/platform/windows/guard-logic.ts';
import { AudioEndpoint, NO_ENDPOINT, NO_ENDPOINT_RETRY_MS } from '../src/platform/windows/audio-endpoint.ts';
import type { AudioSessions } from '../src/platform/windows/audio-sessions.ts';
import { MuteLogic } from '../src/platform/windows/mute-logic.ts';
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
  /** A session the walk could not read, reported the way `listSessions` does. */
  unreadable: string | null = null;

  add(pid: number): { muted: boolean; gone?: boolean } {
    const mixer = { muted: false };
    this.mixers.set(pid, mixer);
    return mixer;
  }

  list = (skipped: (message: string) => void): AudioSession[] => {
    if (this.throws !== null) throw new Error(this.throws);
    if (this.unreadable !== null) skipped(this.unreadable);
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

  test('one unreadable session does not stop the walk, and is reported once', () => {
    const endpoint = new FakeEndpoint();
    endpoint.unreadable = 'IAudioSessionControl2::GetProcessId failed with 0x88890004';
    const mixer = endpoint.add(MUTED_PID);
    const mute = new MuteLogic(endpoint.list, true);

    mute.addPid('thr_one', MUTED_PID);
    mute.tick();
    mute.tick();

    expect(mixer.muted).toBe(true);
    expect(mute.mutedPids()).toEqual([MUTED_PID]);
    expect(mute.takeEvents()).toEqual([
      { kind: 'audio-failed', message: 'IAudioSessionControl2::GetProcessId failed with 0x88890004' },
      { kind: 'session-muted', threadId: 'thr_one', pid: MUTED_PID },
    ]);
  });

  test('only a failure of the endpoint itself fails the whole walk', () => {
    expect(isEndpointWide(new ComError('IAudioSessionEnumerator::GetSession', 0x88890004 | 0))).toBe(true);
    expect(isEndpointWide(new ComError('IAudioSessionControl2::GetProcessId', 0x80010108 | 0))).toBe(true);
    expect(isEndpointWide(new ComError('IUnknown::QueryInterface(ISimpleAudioVolume)', 0x80004002 | 0))).toBe(false);
    expect(isEndpointWide(new Error('IAudioSessionEnumerator::GetSession answered S_OK and no interface'))).toBe(false);
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

// -- which endpoint the mute walks -----------------------------------------

/** One device as `openSessions` hands it out: its own mixer, and a default flag. */
class FakeDevice {
  readonly endpoint = new FakeEndpoint();
  isDefault = true;
  released = false;
  staleThrows = false;

  sessions(): AudioSessions {
    return {
      list: (skipped) => this.endpoint.list(skipped ?? (() => undefined)),
      stale: () => {
        if (this.staleThrows) throw new Error('IMMDevice::GetId failed with 0x80070005');
        return !this.isDefault;
      },
      release: () => {
        this.released = true;
      },
    };
  }
}

describe('the audio endpoint the mute walks', () => {
  test('a switch of the default output device moves the walk to the new device', () => {
    const speakers = new FakeDevice();
    const headset = new FakeDevice();
    let current = speakers;
    let opened = 0;
    const endpoint = new AudioEndpoint(() => {
      opened += 1;
      return current.sessions();
    });
    const mute = new MuteLogic((skipped) => endpoint.list(skipped), true);

    const onSpeakers = speakers.endpoint.add(MUTED_PID);
    mute.addPid('thr_one', MUTED_PID);
    expect(onSpeakers.muted).toBe(true);

    // The user picks the headset: the speakers stay a valid device, and the
    // agent reopens its stream on the headset.
    speakers.isDefault = false;
    headset.isDefault = true;
    current = headset;
    const onHeadset = headset.endpoint.add(MUTED_PID);
    mute.tick();

    expect(opened).toBe(2);
    expect(speakers.released).toBe(true);
    expect(onHeadset.muted).toBe(true);
    // The session held on the speakers is still given back when the pid exits.
    mute.removePid(MUTED_PID);
    expect([onSpeakers.muted, onHeadset.muted]).toEqual([false, false]);
  });

  test('the same default device is walked again without reopening it', () => {
    const device = new FakeDevice();
    let opened = 0;
    const endpoint = new AudioEndpoint(() => {
      opened += 1;
      return device.sessions();
    });
    endpoint.list(() => undefined);
    endpoint.list(() => undefined);
    expect(opened).toBe(1);

    device.staleThrows = true;
    endpoint.list(() => undefined);
    expect(opened).toBe(2);
  });

  test('a machine with no render endpoint is asked again every half minute, not every walk', () => {
    let clock = 1_000;
    let available: FakeDevice | null = null;
    let opened = 0;
    const endpoint = new AudioEndpoint(() => {
      opened += 1;
      return available?.sessions() ?? null;
    }, () => clock);

    const walk = (): string | null => {
      try {
        endpoint.list(() => undefined);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(walk()).toBe(NO_ENDPOINT);
    clock += 1_000;
    expect(walk()).toBe(NO_ENDPOINT);
    expect(opened).toBe(1);

    // A headset is plugged in.
    available = new FakeDevice();
    clock += NO_ENDPOINT_RETRY_MS;
    expect(walk()).toBeNull();
    expect(opened).toBe(2);
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

  test('stops once nothing traced runs, and comes back with the next process', async () => {
    setGuardWorkerForTests(null, 50);
    try {
      const procs = harness.core.procs;
      await procs.spawn('guard-idle', 'cmd', ['/c', 'exit 0']).exited;
      await waitFor(() => procs.liveCount('guard-idle') === 0, 5000);
      await waitFor(() => !procs.guardStatus().running, 5000);

      const next = procs.spawn('guard-idle', 'ping', ['-n', '30', '127.0.0.1']);
      expect(procs.guardStatus().running).toBe(true);
      await waitFor(() => procs.guardStatus().hook !== null, 10000);
      procs.killTree('guard-idle');
      await next.exited;
    } finally {
      setGuardWorkerForTests(null);
    }
  }, 30000);
});
