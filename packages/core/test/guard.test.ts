import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GuardLogic, HWND_BOTTOM, PUSH_BACK_FLAGS } from '../src/platform/guard-logic.ts';
import type { GuardWin32, WindowOwner } from '../src/platform/guard-logic.ts';
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
});
